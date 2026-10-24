import crypto from 'crypto';

// Raw body required for HMAC signature verification —
// disable Vercel's automatic JSON parsing.
export const config = {
  api: {
    bodyParser: false,
  },
};

// Required env vars (Vercel → Settings → Environment Variables):
//   LEMONSQUEEZY_WEBHOOK_SECRET  signing secret of the Lemon Squeezy webhook
//   SUPABASE_URL                 project URL; any path / trailing slash is stripped
//   SUPABASE_SECRET_KEY          service_role (or sb_secret_…) key
//   LAZYSHIFT_VARIANT_IDS        comma-separated LazyShift variant IDs. The store
//                                is shared with calculatorture.ro, so events for
//                                any other variant are acknowledged and ignored.

const SUBSCRIPTION_EVENTS = new Set([
  'subscription_created',
  'subscription_updated',
  'subscription_cancelled',
  'subscription_resumed',
  'subscription_expired',
  'subscription_paused',
  'subscription_unpaused',
]);

// subscription_payment_refunded → data is a subscription invoice (no variant_id;
//   matched against the subscription id we stored for the user instead).
// order_refunded → data is an order (variant in first_order_item).
const REFUND_EVENTS = new Set([
  'subscription_payment_refunded',
  'order_refunded',
]);

const DAY_MS = 24 * 60 * 60 * 1000;
// Slack after renews_at so a renewal webhook arriving late doesn't lock out
// a paying user (auth.js treats Pro as expired once premium_expires passes).
const RENEWAL_GRACE_DAYS = 3;
// past_due = renewal payment failed and Lemon Squeezy is retrying the card
// (dunning, ~2 weeks). Keep access meanwhile; unpaid/expired ends it.
const PAST_DUE_GRACE_DAYS = 14;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function isValidSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const sigBuffer    = Buffer.from(signatureHeader, 'utf8');
  const digestBuffer = Buffer.from(digest, 'utf8');
  if (sigBuffer.length !== digestBuffer.length) return false;
  return crypto.timingSafeEqual(sigBuffer, digestBuffer);
}

// findUserIdByEmail / patchUser append /rest/v1/... themselves, so only the
// bare origin may be used — '…supabase.co/rest/v1/' or a trailing slash in
// the env var would otherwise produce broken URLs.
function normalizeSupabaseUrl(raw) {
  try {
    return new URL(raw.trim()).origin;
  } catch {
    return null;
  }
}

function parseVariantIds(raw) {
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

function addDays(iso, days) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t + days * DAY_MS).toISOString();
}

// cancelled = user stopped renewal but keeps access until ends_at.
// past_due = keeps access during dunning.
// paused / unpaid / expired = access terminated.
function resolvePremiumState(attrs) {
  const now = new Date().toISOString();
  switch (attrs.status) {
    case 'active':
    case 'on_trial':
      return { isPro: true, premiumExpires: addDays(attrs.renews_at, RENEWAL_GRACE_DAYS) };
    case 'cancelled':
      return { isPro: true, premiumExpires: attrs.ends_at };
    case 'past_due':
      return { isPro: true, premiumExpires: addDays(attrs.renews_at || now, PAST_DUE_GRACE_DAYS) };
    default:
      return { isPro: false, premiumExpires: attrs.ends_at || now };
  }
}

// fetch() only throws on network-level failures (DNS, TLS, refused
// connection) with the generic message "fetch failed" — the actual reason
// is in err.cause, which must be surfaced to be diagnosable.
function describeError(err) {
  const cause = err?.cause;
  return {
    error: err?.message || String(err),
    cause: cause ? [cause.code, cause.message].filter(Boolean).join(': ') || String(cause) : undefined,
  };
}

function supabaseHeaders(key, extra = {}) {
  return {
    'Content-Type': 'application/json',
    apikey: key,
    Authorization: `Bearer ${key}`,
    ...extra,
  };
}

async function findUserIdByEmail(supabaseUrl, supabaseSecretKey, email) {
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/get_user_id_by_email`, {
    method: 'POST',
    headers: supabaseHeaders(supabaseSecretKey),
    body: JSON.stringify({ lookup_email: email.trim().toLowerCase() }),
  });
  if (!res.ok) {
    throw new Error(`RPC get_user_id_by_email failed: ${res.status} ${await res.text()}`);
  }
  return res.json(); // uuid string or null
}

// Paid with no matching account: keep the computed state so the
// auth.users trigger can apply it once that email signs up and confirms.
// Redeliveries hit the (email, event, event_updated_at) unique key and
// are ignored.
async function storePendingEntitlement(supabaseUrl, supabaseSecretKey, entry) {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/pending_entitlements?on_conflict=email,event,event_updated_at`,
    {
      method: 'POST',
      headers: supabaseHeaders(supabaseSecretKey, { Prefer: 'resolution=ignore-duplicates,return=minimal' }),
      body: JSON.stringify(entry),
    }
  );
  if (!res.ok) {
    throw new Error(`INSERT pending_entitlements failed: ${res.status} ${await res.text()}`);
  }
}

// Conditional PATCH: only applies when the event is newer than the last one
// applied (users.ls_updated_at), so retried or out-of-order deliveries can't
// roll the state back (e.g. a late subscription_updated after _expired).
// Returns true if a row was updated.
async function patchUser(supabaseUrl, supabaseSecretKey, filters, eventUpdatedAt, row) {
  const params = new URLSearchParams(filters);
  params.set('or', `(ls_updated_at.is.null,ls_updated_at.lt.${eventUpdatedAt})`);
  params.set('select', 'id');

  const res = await fetch(`${supabaseUrl}/rest/v1/users?${params}`, {
    method: 'PATCH',
    headers: supabaseHeaders(supabaseSecretKey, { Prefer: 'return=representation' }),
    body: JSON.stringify({ ...row, ls_updated_at: eventUpdatedAt }),
  });
  if (!res.ok) {
    throw new Error(`PATCH users failed: ${res.status} ${await res.text()}`);
  }
  const updated = await res.json();
  return Array.isArray(updated) && updated.length > 0;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const webhookSecret     = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  const supabaseUrlRaw    = process.env.SUPABASE_URL;
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
  const variantIdsRaw     = process.env.LAZYSHIFT_VARIANT_IDS;

  if (!webhookSecret || !supabaseUrlRaw || !supabaseSecretKey || !variantIdsRaw) {
    return res.status(500).json({ error: 'Missing server environment variables.' });
  }

  const supabaseUrl = normalizeSupabaseUrl(supabaseUrlRaw);
  if (!supabaseUrl) {
    return res.status(500).json({ error: 'SUPABASE_URL is not a valid URL.' });
  }
  const allowedVariants = parseVariantIds(variantIdsRaw);

  const rawBody = await readRawBody(req);

  if (!isValidSignature(rawBody, req.headers['x-signature'], webhookSecret)) {
    return res.status(401).json({ error: 'Invalid signature.' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON payload.' });
  }

  const eventName = payload?.meta?.event_name;
  const attrs     = payload?.data?.attributes;
  const isSubscriptionEvent = SUBSCRIPTION_EVENTS.has(eventName);
  const isRefundEvent       = REFUND_EVENTS.has(eventName);

  if ((!isSubscriptionEvent && !isRefundEvent) || !attrs) {
    // Other events (order_created etc.) — acknowledge but ignore.
    return res.status(200).json({ ignored: true, event: eventName ?? null });
  }

  // Shared store: drop events for other products (calculatorture.ro).
  // Subscription invoices carry no variant — those are scoped by the
  // stored subscription id in the PATCH filter below instead.
  if (eventName !== 'subscription_payment_refunded') {
    const variantId = attrs.variant_id ?? attrs.first_order_item?.variant_id;
    if (!allowedVariants.has(String(variantId))) {
      return res.status(200).json({ ignored: true, event: eventName, reason: 'variant not in LAZYSHIFT_VARIANT_IDS' });
    }
  }

  // Partial refunds don't revoke access.
  if (isRefundEvent && !(attrs.refunded === true || attrs.status === 'refunded')) {
    return res.status(200).json({ ignored: true, event: eventName, reason: 'not a full refund' });
  }

  const eventUpdatedAtMs = Date.parse(attrs.updated_at);
  if (Number.isNaN(eventUpdatedAtMs)) {
    return res.status(400).json({ error: 'Missing or invalid updated_at in payload.' });
  }
  const eventUpdatedAt = new Date(eventUpdatedAtMs).toISOString();

  try {
    // Prefer the user id passed through checkout[custom][user_id]; the
    // checkout email may differ from the LazyShift account email.
    const customUserId = payload?.meta?.custom_data?.user_id;
    let userId = typeof customUserId === 'string' && UUID_RE.test(customUserId) ? customUserId : null;

    if (!userId && attrs.user_email) {
      userId = await findUserIdByEmail(supabaseUrl, supabaseSecretKey, attrs.user_email);
    }

    let row;
    if (isSubscriptionEvent) {
      const { isPro, premiumExpires } = resolvePremiumState(attrs);
      row = {
        is_pro: isPro,
        premium_expires: premiumExpires,
        lemon_squeezy_subscription_id: String(payload.data.id),
      };
    } else {
      row = { is_pro: false, premium_expires: new Date().toISOString() };
    }

    if (!userId) {
      if (!attrs.user_email) {
        console.warn('lemonsqueezy-webhook: no account and no email for event', eventName, payload?.data?.id);
        return res.status(200).json({ warning: 'No account found for this event.' });
      }
      await storePendingEntitlement(supabaseUrl, supabaseSecretKey, {
        email: attrs.user_email.trim().toLowerCase(),
        event: eventName,
        payload,
        is_pro: row.is_pro,
        premium_expires: row.premium_expires,
        subscription_id: isSubscriptionEvent
          ? String(payload.data.id)
          : (attrs.subscription_id != null ? String(attrs.subscription_id) : null),
        event_updated_at: eventUpdatedAt,
      });
      return res.status(200).json({ ok: true, pending: true, event: eventName });
    }

    let filters = { id: `eq.${userId}` };
    if (eventName === 'subscription_payment_refunded') {
      filters = { ...filters, lemon_squeezy_subscription_id: `eq.${attrs.subscription_id}` };
    }

    const applied = await patchUser(supabaseUrl, supabaseSecretKey, filters, eventUpdatedAt, row);
    if (!applied) {
      return res.status(200).json({ ok: true, skipped: 'stale event or no matching subscription' });
    }

    return res.status(200).json({ ok: true, event: eventName, isPro: row.is_pro, premiumExpires: row.premium_expires });
  } catch (err) {
    const details = describeError(err);
    console.error('lemonsqueezy-webhook failed', eventName, details);
    // 500 → Lemon Squeezy retries the delivery.
    return res.status(500).json(details);
  }
}
