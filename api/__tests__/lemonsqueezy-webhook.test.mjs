// Unit tests for api/lemonsqueezy-webhook.js — no network, no database.
// global.fetch is replaced by a fake Supabase that records every call;
// payloads are signed with a test secret like Lemon Squeezy signs them.
//
// Run: node --test 'api/__tests__/*.test.mjs'

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'

import handler from '../lemonsqueezy-webhook.js'

const SECRET     = 'test-webhook-secret'
const VARIANT    = '111111'
const OTHER      = '999999' // another product in the shared store
const USER_ID    = '0b6c6f8e-1c2d-4e5f-8a9b-0c1d2e3f4a5b'
const SUPABASE   = 'https://fake-project.supabase.test'
const DAY_MS     = 24 * 60 * 60 * 1000

// ── Fake Supabase ──────────────────────────────────────────

let calls
let routes // [{ match(url, init) → bool, reply(url, init) → Response }]
const realFetch = globalThis.fetch

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  calls  = []
  routes = []
  globalThis.fetch = async (url, init = {}) => {
    url = String(url)
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined })
    assert.ok(url.startsWith(SUPABASE + '/'), `unexpected request to ${url}`)
    const route = routes.find(r => r.match(url, init))
    assert.ok(route, `no fake route for ${init.method} ${url}`)
    return route.reply(url, init)
  }
  process.env.LEMONSQUEEZY_WEBHOOK_SECRET = SECRET
  process.env.SUPABASE_URL                = SUPABASE + '/rest/v1/' // normalized to the origin
  process.env.SUPABASE_SECRET_KEY         = 'test-service-key'
  process.env.LAZYSHIFT_VARIANT_IDS       = ` ${VARIANT} , 222222`
})

afterEach(() => {
  globalThis.fetch = realFetch
})

// Users PATCH: replies with the updated rows (empty = filter didn't match,
// i.e. a stale event or the wrong subscription).
function patchUsersReplies(rows) {
  routes.push({
    match: (url, init) => init.method === 'PATCH' && url.includes('/rest/v1/users?'),
    reply: () => json(rows),
  })
}

function rpcLookupReplies(userId) {
  routes.push({
    match: (url, init) => init.method === 'POST' && url.endsWith('/rest/v1/rpc/get_user_id_by_email'),
    reply: () => json(userId),
  })
}

function pendingInsertReplies() {
  routes.push({
    match: (url, init) => init.method === 'POST' && url.includes('/rest/v1/pending_entitlements'),
    reply: () => new Response(null, { status: 201 }),
  })
}

// ── Request / response helpers ─────────────────────────────

function sign(raw, secret = SECRET) {
  return crypto.createHmac('sha256', secret).update(raw).digest('hex')
}

async function deliver(payload, { signature } = {}) {
  const raw = Buffer.from(JSON.stringify(payload))
  const req = Readable.from([raw])
  req.method  = 'POST'
  req.headers = { 'x-signature': signature === undefined ? sign(raw) : signature }

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

function subscriptionEvent(event, attrs, { userId = USER_ID, id = 5001 } = {}) {
  return {
    meta: { event_name: event, custom_data: userId ? { user_id: userId } : {} },
    data: {
      type: 'subscriptions',
      id: String(id),
      attributes: {
        variant_id: Number(VARIANT),
        user_email: 'Worker@Example.com',
        status: 'active',
        renews_at: '2026-11-24T10:00:00.000Z',
        ends_at: null,
        updated_at: '2026-10-24T10:00:00.000Z',
        ...attrs,
      },
    },
  }
}

const patchCalls = () => calls.filter(c => c.method === 'PATCH')

// ── Tests ──────────────────────────────────────────────────

test('unknown variant is acknowledged with 200 and touches no database', async () => {
  const res = await deliver(subscriptionEvent('subscription_created', { variant_id: Number(OTHER) }))
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.ignored, true)
  assert.match(res.body.reason, /variant/)
  assert.equal(calls.length, 0)
})

test('valid signature is accepted and the user becomes Pro', async () => {
  patchUsersReplies([{ id: USER_ID }])
  const res = await deliver(subscriptionEvent('subscription_created', {}))

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.isPro, true)

  const [patch] = patchCalls()
  assert.ok(patch, 'users row patched')
  const params = new URL(patch.url).searchParams
  assert.equal(params.get('id'), `eq.${USER_ID}`) // matched by custom_data.user_id, no email lookup
  assert.equal(calls.filter(c => c.url.includes('/rpc/')).length, 0)
  assert.equal(patch.body.is_pro, true)
  assert.equal(patch.body.lemon_squeezy_subscription_id, '5001')
  assert.equal(patch.body.ls_updated_at, '2026-10-24T10:00:00.000Z')
  // renews_at + 3 days of grace
  assert.equal(patch.body.premium_expires, new Date(Date.parse('2026-11-24T10:00:00.000Z') + 3 * DAY_MS).toISOString())
})

test('bad signature is rejected with 401 and touches no database', async () => {
  const payload = subscriptionEvent('subscription_created', {})
  const forged  = sign(Buffer.from(JSON.stringify(payload)), 'wrong-secret')

  const res = await deliver(payload, { signature: forged })
  assert.equal(res.statusCode, 401)
  assert.equal(calls.length, 0)

  const missing = await deliver(payload, { signature: '' })
  assert.equal(missing.statusCode, 401)
  assert.equal(calls.length, 0)
})

test('full refund revokes Pro', async () => {
  patchUsersReplies([{ id: USER_ID }])
  const res = await deliver({
    meta: { event_name: 'order_refunded', custom_data: { user_id: USER_ID } },
    data: {
      type: 'orders',
      id: '7001',
      attributes: {
        first_order_item: { variant_id: Number(VARIANT) },
        user_email: 'worker@example.com',
        status: 'refunded',
        refunded: true,
        updated_at: '2026-10-25T09:00:00.000Z',
      },
    },
  })

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.isPro, false)
  const [patch] = patchCalls()
  assert.equal(patch.body.is_pro, false)
  assert.ok(Date.parse(patch.body.premium_expires) <= Date.now())
})

test('subscription payment refund only applies to the stored subscription', async () => {
  patchUsersReplies([{ id: USER_ID }])
  const res = await deliver({
    meta: { event_name: 'subscription_payment_refunded', custom_data: { user_id: USER_ID } },
    data: {
      type: 'subscription-invoices',
      id: '8001',
      attributes: {
        subscription_id: 5001,
        user_email: 'worker@example.com',
        status: 'refunded',
        refunded: true,
        updated_at: '2026-10-25T09:00:00.000Z',
      },
    },
  })
  assert.equal(res.statusCode, 200)
  const params = new URL(patchCalls()[0].url).searchParams
  assert.equal(params.get('lemon_squeezy_subscription_id'), 'eq.5001')
  assert.equal(patchCalls()[0].body.is_pro, false)
})

test('past_due keeps Pro during the dunning grace period', async () => {
  patchUsersReplies([{ id: USER_ID }])
  const renewsAt = '2026-10-20T10:00:00.000Z'
  const res = await deliver(subscriptionEvent('subscription_updated', { status: 'past_due', renews_at: renewsAt }))

  assert.equal(res.statusCode, 200)
  const [patch] = patchCalls()
  assert.equal(patch.body.is_pro, true)
  assert.equal(patch.body.premium_expires, new Date(Date.parse(renewsAt) + 14 * DAY_MS).toISOString())
})

test('out-of-order (older) event is ignored', async () => {
  // The database already holds a newer event: the conditional PATCH
  // matches no row and returns [].
  patchUsersReplies([])
  const res = await deliver(subscriptionEvent('subscription_updated', {
    status: 'active',
    updated_at: '2026-10-01T00:00:00.000Z',
  }))

  assert.equal(res.statusCode, 200)
  assert.match(res.body.skipped, /stale/)
  const params = new URL(patchCalls()[0].url).searchParams
  assert.equal(params.get('or'), '(ls_updated_at.is.null,ls_updated_at.lt.2026-10-01T00:00:00.000Z)')
})

test('payment with no matching account goes to pending_entitlements', async () => {
  rpcLookupReplies(null) // no account with that email
  pendingInsertReplies()
  const res = await deliver(subscriptionEvent('subscription_created', {}, { userId: null }))

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.pending, true)

  const rpc = calls.find(c => c.url.endsWith('/rpc/get_user_id_by_email'))
  assert.deepEqual(rpc.body, { lookup_email: 'worker@example.com' })

  const insert = calls.find(c => c.url.includes('/pending_entitlements'))
  assert.ok(insert, 'pending entitlement stored')
  assert.equal(insert.body.email, 'worker@example.com')
  assert.equal(insert.body.event, 'subscription_created')
  assert.equal(insert.body.is_pro, true)
  assert.equal(insert.body.subscription_id, '5001')
  assert.equal(insert.body.event_updated_at, '2026-10-24T10:00:00.000Z')
  assert.equal(patchCalls().length, 0)
})
