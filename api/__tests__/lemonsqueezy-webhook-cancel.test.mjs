// Cancellation / grace-period tests for api/lemonsqueezy-webhook.js — no
// network, no database. global.fetch is replaced by a fake Supabase that keeps
// one users row in memory and applies the webhook's conditional PATCH filter
// (ls_updated_at is null or older than the event) the way PostgREST would, so
// sequences of events can be checked end to end.
//
// Run: node --test 'api/__tests__/*.test.mjs'

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'

import handler from '../lemonsqueezy-webhook.js'

const SECRET   = 'test-webhook-secret'
const VARIANT  = 2291102
const USER_ID  = '0b6c6f8e-1c2d-4e5f-8a9b-0c1d2e3f4a5b'
const SUB_ID   = '5001'
const SUPABASE = 'https://fake-project.supabase.test'
const DAY_MS   = 24 * 60 * 60 * 1000

// ── Fake Supabase with one stateful users row ──────────────

let calls
let user // { id, is_pro, premium_expires, lemon_squeezy_subscription_id, ls_updated_at }
const realFetch = globalThis.fetch

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// Evaluates the webhook's `or=(ls_updated_at.is.null,ls_updated_at.lt.<ts>)`.
function orFilterMatches(orParam, row) {
  const m = /^\(ls_updated_at\.is\.null,ls_updated_at\.lt\.(.+)\)$/.exec(orParam || '')
  assert.ok(m, `unexpected or filter: ${orParam}`)
  return row.ls_updated_at === null || Date.parse(row.ls_updated_at) < Date.parse(m[1])
}

beforeEach(() => {
  calls = []
  user  = { id: USER_ID, is_pro: false, premium_expires: null, lemon_squeezy_subscription_id: null, ls_updated_at: null }
  globalThis.fetch = async (url, init = {}) => {
    url = String(url)
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ url, method: init.method || 'GET', body })
    assert.ok(url.startsWith(SUPABASE + '/rest/v1/users?'), `unexpected request to ${url}`)
    assert.equal(init.method, 'PATCH')

    const params = new URL(url).searchParams
    if (params.get('id') !== `eq.${user.id}` || !orFilterMatches(params.get('or'), user)) {
      return json([])
    }
    Object.assign(user, body)
    return json([{ id: user.id }])
  }
  process.env.LEMONSQUEEZY_WEBHOOK_SECRET = SECRET
  process.env.SUPABASE_URL                = SUPABASE
  process.env.SUPABASE_SECRET_KEY         = 'test-service-key'
  process.env.LAZYSHIFT_VARIANT_IDS       = String(VARIANT)
})

afterEach(() => {
  globalThis.fetch = realFetch
})

// ── Request / payload helpers ──────────────────────────────

async function deliver(payload) {
  const raw = Buffer.from(JSON.stringify(payload))
  const req = Readable.from([raw])
  req.method  = 'POST'
  req.headers = { 'x-signature': crypto.createHmac('sha256', SECRET).update(raw).digest('hex') }

  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(body)   { this.body = body; return this },
    end()        { return this },
  }
  await handler(req, res)
  return res
}

// Lemon Squeezy timestamps carry microseconds: 2026-10-26T12:00:00.000000Z
const lsTime = (ms) => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z')

// Shaped like a Lemon Squeezy subscription webhook (only the fields used here).
function subscriptionEvent(event, attrs) {
  return {
    meta: { event_name: event, test_mode: true, custom_data: { user_id: USER_ID } },
    data: {
      type: 'subscriptions',
      id: SUB_ID,
      attributes: {
        store_id: 1,
        variant_id: VARIANT,
        user_email: 'worker@example.com',
        test_mode: true,
        ...attrs,
      },
    },
  }
}

// Same check auth.js uses to decide Pro.
const isProNow = (row) => row.is_pro && (!row.premium_expires || new Date(row.premium_expires) > new Date())

// Cancelled mid-period: Lemon Squeezy keeps the subscription until ends_at.
function graceCancellation(event, { now, endsAt }) {
  return subscriptionEvent(event, {
    status: 'cancelled',
    cancelled: true,
    renews_at: lsTime(endsAt),
    ends_at: lsTime(endsAt),
    updated_at: lsTime(now),
  })
}

// ── a) cancelled with ends_at in the future ────────────────

test('a) subscription_cancelled with ends_at in the future keeps Pro until ends_at', async () => {
  const now    = Date.now()
  const endsAt = now + 20 * DAY_MS

  const res = await deliver(graceCancellation('subscription_cancelled', { now, endsAt }))

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.ok, true)
  assert.equal(user.is_pro, true)
  assert.ok(Date.parse(user.premium_expires) >= endsAt, `premium_expires ${user.premium_expires} is before ends_at`)
  assert.equal(user.lemon_squeezy_subscription_id, SUB_ID)
  assert.ok(isProNow(user))
})

test('a) a later subscription_updated still in the grace period keeps Pro until ends_at', async () => {
  const now    = Date.now()
  const endsAt = now + 20 * DAY_MS

  await deliver(graceCancellation('subscription_cancelled', { now: now - 60_000, endsAt }))
  const res = await deliver(graceCancellation('subscription_updated', { now, endsAt }))

  assert.equal(res.body.ok, true)
  assert.equal(res.body.skipped, undefined)
  assert.equal(user.is_pro, true)
  assert.ok(Date.parse(user.premium_expires) >= endsAt)
  assert.ok(isProNow(user))
})

// ── b) ended immediately (status expired, ends_at = now) ───

for (const event of ['subscription_cancelled', 'subscription_expired']) {
  test(`b) ${event} with status expired and ends_at = now revokes Pro`, async () => {
    Object.assign(user, { is_pro: true, premium_expires: new Date(Date.now() + 30 * DAY_MS).toISOString() })
    const now = Date.now()

    const res = await deliver(subscriptionEvent(event, {
      status: 'expired',
      cancelled: true,
      renews_at: lsTime(now),
      ends_at: lsTime(now),
      updated_at: lsTime(now),
    }))

    assert.equal(res.statusCode, 200)
    assert.equal(res.body.isPro, false)
    assert.equal(user.is_pro, false)
    assert.ok(Date.parse(user.premium_expires) <= Date.now())
    assert.ok(!isProNow(user))
  })
}

// ── c) subscription_expired on its own ─────────────────────

test('c) subscription_expired after the grace period ends revokes Pro', async () => {
  const start  = Date.now() - 40 * DAY_MS
  const endsAt = Date.now() - 1000

  await deliver(graceCancellation('subscription_cancelled', { now: start, endsAt }))
  const res = await deliver(subscriptionEvent('subscription_expired', {
    status: 'expired',
    cancelled: true,
    renews_at: lsTime(endsAt),
    ends_at: lsTime(endsAt),
    updated_at: lsTime(endsAt),
  }))

  assert.equal(res.body.ok, true)
  assert.equal(user.is_pro, false)
  assert.ok(!isProNow(user))
})

test('c) subscription_expired with no earlier event for the user revokes Pro', async () => {
  Object.assign(user, { is_pro: true, premium_expires: null })
  const now = Date.now()

  const res = await deliver(subscriptionEvent('subscription_expired', {
    status: 'expired',
    cancelled: false,
    renews_at: lsTime(now),
    ends_at: lsTime(now),
    updated_at: lsTime(now),
  }))

  assert.equal(res.body.ok, true)
  assert.equal(user.is_pro, false)
  assert.ok(!isProNow(user))
})

// ── d) subscription_updated in the same second as the cancellation ──

test('d) subscription_updated with the same updated_at after the cancellation is skipped; Pro kept', async () => {
  const now    = Date.now()
  const endsAt = now + 20 * DAY_MS

  await deliver(graceCancellation('subscription_cancelled', { now, endsAt }))
  const after = { ...user }
  const res = await deliver(graceCancellation('subscription_updated', { now, endsAt }))

  assert.match(res.body.skipped, /stale/)
  assert.deepEqual(user, after)
  assert.equal(user.ls_updated_at, new Date(now).toISOString())
  assert.ok(isProNow(user))
})

test('d) subscription_cancelled with the same updated_at after subscription_updated is skipped; Pro kept', async () => {
  const now    = Date.now()
  const endsAt = now + 20 * DAY_MS

  await deliver(graceCancellation('subscription_updated', { now, endsAt }))
  const res = await deliver(graceCancellation('subscription_cancelled', { now, endsAt }))

  assert.match(res.body.skipped, /stale/)
  assert.equal(user.is_pro, true)
  assert.ok(Date.parse(user.premium_expires) >= endsAt)
  assert.ok(isProNow(user))
})

test('d) an older subscription_updated (status active) delivered after the cancellation is ignored', async () => {
  const now    = Date.now()
  const endsAt = now + 20 * DAY_MS

  await deliver(graceCancellation('subscription_cancelled', { now, endsAt }))
  const after = { ...user }
  const res = await deliver(subscriptionEvent('subscription_updated', {
    status: 'active',
    cancelled: false,
    renews_at: lsTime(endsAt),
    ends_at: null,
    updated_at: lsTime(now - 1000),
  }))

  assert.match(res.body.skipped, /stale/)
  assert.deepEqual(user, after)
})

// ── e) resumed after a grace-period cancellation ───────────

test('e) subscription_resumed after a grace-period cancellation makes the user Pro again', async () => {
  const cancelledAt = Date.now() - 5 * DAY_MS
  const endsAt      = Date.now() + 15 * DAY_MS
  const resumedAt   = Date.now()

  await deliver(graceCancellation('subscription_cancelled', { now: cancelledAt, endsAt }))
  const res = await deliver(subscriptionEvent('subscription_resumed', {
    status: 'active',
    cancelled: false,
    renews_at: lsTime(endsAt),
    ends_at: null,
    updated_at: lsTime(resumedAt),
  }))

  assert.equal(res.body.ok, true)
  assert.equal(res.body.isPro, true)
  assert.equal(user.is_pro, true)
  // renews_at + 3 days of renewal grace
  assert.equal(user.premium_expires, new Date(endsAt + 3 * DAY_MS).toISOString())
  assert.ok(isProNow(user))
})
