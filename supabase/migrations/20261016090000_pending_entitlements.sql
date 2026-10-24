-- =====================================================================
-- LAZYSHIFT — Migration: pending_entitlements
-- Lemon Squeezy events for which no LazyShift account exists yet (the
-- buyer paid before signing up, or paid with another email and checkout
-- had no user_id). Until now api/lemonsqueezy-webhook.js logged these and
-- returned 200, so the payment was lost. The webhook now stores them here,
-- and the auth.users trigger (next migration) applies the newest one for
-- an email once that email is confirmed.
--
-- Besides email / event / payload / created_at / applied_at, the row keeps
-- the state the webhook already computed (is_pro, premium_expires,
-- subscription_id, event_updated_at). That way the premium rules
-- (grace days, past_due, refunds) live only in the webhook and are not
-- re-implemented in SQL.
--
-- Access: service_role only (the webhook). The trigger function is
-- SECURITY DEFINER and runs as the owner.
-- =====================================================================

create table if not exists public.pending_entitlements (
  id               bigint generated always as identity primary key,
  email            text        not null,  -- lowercased by the webhook
  event            text        not null,  -- meta.event_name
  payload          jsonb       not null,  -- full webhook body, for audit
  is_pro           boolean     not null,
  premium_expires  timestamptz,
  subscription_id  text,
  event_updated_at timestamptz not null,  -- data.attributes.updated_at
  created_at       timestamptz not null default now(),
  applied_at       timestamptz,
  applied_user_id  uuid references auth.users(id) on delete set null,
  -- Lemon Squeezy redelivers the same event; keep one row per delivery.
  constraint pending_entitlements_dedupe unique (email, event, event_updated_at)
);

create index if not exists pending_entitlements_unapplied_email_idx
  on public.pending_entitlements (email)
  where applied_at is null;

alter table public.pending_entitlements enable row level security;
-- No policies: RLS denies every role except service_role / the owner.
revoke all on table public.pending_entitlements from public, anon, authenticated;
grant all on table public.pending_entitlements to service_role;
