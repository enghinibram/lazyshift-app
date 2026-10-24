-- =====================================================================
-- LAZYSHIFT — Migration: event ordering for the Lemon Squeezy webhook
-- api/lemonsqueezy-webhook.js only applies an event when its
-- data.attributes.updated_at is newer than users.ls_updated_at, so retried
-- or out-of-order deliveries can't roll premium status back (e.g. a late
-- subscription_updated arriving after subscription_expired).
--
-- public.users itself was created from the dashboard (not in migrations);
-- lemon_squeezy_subscription_id is already written by the webhook and is
-- added here only if missing, so this runs on any copy of the schema.
-- =====================================================================

alter table public.users
  add column if not exists ls_updated_at timestamptz;

alter table public.users
  add column if not exists lemon_squeezy_subscription_id text;
