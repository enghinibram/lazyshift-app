// ---------------------------------------------------------------------
// FILE: /api/vapid-public-key.js
// Exposes the VAPID public key (needed in the browser for
// pushManager.subscribe) without hardcoding it in app.js. The private
// key stays server-side only (Supabase Edge Function secrets).
// ---------------------------------------------------------------------

export default function handler(req, res) {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  if (!publicKey) {
    return res.status(500).json({ error: 'VAPID_PUBLIC_KEY is not configured on the server.' });
  }
  res.status(200).json({ publicKey });
}
