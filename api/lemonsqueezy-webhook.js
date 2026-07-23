import crypto from 'crypto';

// Raw body required for HMAC signature verification —
// disable Vercel's automatic JSON parsing.
export const config = {
  api: {
    bodyParser: false,
  },
};

const SUBSCRIPTION_EVENTS = new Set([
  'subscription_created',
  'subscription_updated',
  'subscription_cancelled',
  'subscription_expired',
]);

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

// cancelled = user stopped renewal but keeps access until ends_at.
// expired / unpaid / paused = access terminated.
function resolvePremiumState(attrs) {
  const { status } = attrs;
  if (status === 'active' || status === 'on_trial') {
    return { isPro: true, premiumExpires: attrs.renews_at };
  }
  if (status === 'cancelled') {
    return { isPro: true, premiumExpires: attrs.ends_at };
  }
  return { isPro: false, premiumExpires: attrs.ends_at || null };
}

async function findUserIdByEmail(supabaseUrl, supabaseSecretKey, email) {
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/get_user_id_by_email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: supabaseSecretKey,
      Authorization: `Bearer ${supabaseSecretKey}`,
    },
    body: JSON.stringify({ lookup_email: email }),
  });
  if (!res.ok) {
    throw new Error(`RPC get_user_id_by_email failed: ${res.status} ${await res.text()}`);
  }
  return res.json(); // uuid string or null
}

async function upsertUserPremium(supabaseUrl, supabaseSecretKey, userId, row) {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/users?id=eq.${encodeURIComponent(userId)}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseSecretKey,
        Authorization: `Bearer ${supabaseSecretKey}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(row),
    }
  );
  if (!res.ok) {
    throw new Error(`PATCH users failed: ${res.status} ${await res.text()}`);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const webhookSecret    = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  const supabaseUrl      = process.env.SUPABASE_URL;
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

  if (!webhookSecret || !supabaseUrl || !supabaseSecretKey) {
    return res.status(500).json({ error: 'Missing server environment variables.' });
  }

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

  if (!SUBSCRIPTION_EVENTS.has(eventName) || !attrs) {
    // Other events (order_created etc.) — acknowledge but ignore.
    return res.status(200).json({ ignored: true, event: eventName ?? null });
  }

  const email = attrs.user_email;
  if (!email) {
    return res.status(400).json({ error: 'Missing user_email in payload.' });
  }

  const { isPro, premiumExpires } = resolvePremiumState(attrs);

  try {
    const userId = await findUserIdByEmail(supabaseUrl, supabaseSecretKey, email);

    if (!userId) {
      // User paid but has no LazyShift account yet — nothing to update.
      return res.status(200).json({ warning: 'No account found for this email.', email });
    }

    const row = {
      is_pro: isPro,
      premium_expires: premiumExpires,
      lemon_squeezy_subscription_id: String(payload.data.id),
    };

    await upsertUserPremium(supabaseUrl, supabaseSecretKey, userId, row);

    return res.status(200).json({ ok: true, email, isPro, premiumExpires });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
