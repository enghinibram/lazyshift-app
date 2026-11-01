-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
-- NOT APPLIED YET — DO NOT APPLY THIS MIGRATION YET.
-- It lives in supabase/migrations_pending/ on purpose and stays there:
-- it is applied by hand from the Supabase SQL Editor, not by
-- `supabase db push`. The SQL Editor does not record it in Supabase's
-- migration history.
--
-- Apply it BEFORE the webhook that stops sending `payload` is deployed
-- (i.e. before the PR is merged, if main auto-deploys to Vercel):
-- until this runs, payload is NOT NULL and every unmatched payment
-- would return 500 and be retried by Lemon Squeezy.
--   1. run the "before" queries in supabase/verify/pending_entitlements.sql;
--   2. in the SQL Editor, paste `begin;`, then everything below from
--      `alter table` through the closing `);` of cron.schedule, then
--      `commit;`, and run it as one script;
--   3. run the "after" queries in the same verify file.
-- Undo: supabase/rollback/pending_entitlements_rollback.sql
-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

-- =====================================================================
-- LAZYSHIFT — Migration: minimise and purge pending_entitlements
-- Until now the webhook copied the full Lemon Squeezy body into
-- pending_entitlements.payload (name, email, card brand and last 4,
-- portal URLs, amounts) and nothing ever deleted a row. The sign-up
-- trigger (handle_auth_user_change) only reads email, is_pro,
-- premium_expires, subscription_id, event_updated_at and applied_at —
-- never payload — so the copy served no purpose.
--
-- This migration:
--   (a) makes payload nullable and clears it on every row, and deletes
--       rows already applied (their state is on public.users now);
--   (b) schedules a daily pg_cron job that deletes applied rows and
--       rows never applied after 90 days, and clears any payload that
--       still arrives (e.g. if the old webhook is ever redeployed).
-- The statement for the manual account-deletion runbook is in
-- supabase/runbook/account_deletion.sql.
--
-- Idempotent: every statement can run again with the same result.
-- Touches only public.pending_entitlements and cron.job — nothing on
-- public.users or auth.*. The payload column is kept (nullable) so the
-- previous webhook keeps working and rollback needs no schema change.
-- =====================================================================

-- (a) One-time clean-up ------------------------------------------------

alter table public.pending_entitlements
  alter column payload drop not null;

comment on column public.pending_entitlements.payload is
  'Unused. Kept nullable for compatibility; the webhook no longer writes it and the daily purge clears it.';

update public.pending_entitlements
   set payload = null
 where payload is not null;

delete from public.pending_entitlements
 where applied_at is not null;

-- (b) Daily purge ------------------------------------------------------
-- cron.schedule with an existing job name replaces that job, so
-- re-running this migration does not create duplicates. 03:17 UTC keeps
-- it away from the hourly reminder job at minute 0.

select cron.schedule(
  'purge-pending-entitlements-daily',
  '17 3 * * *',
  $$
  update public.pending_entitlements
     set payload = null
   where payload is not null;

  delete from public.pending_entitlements
   where applied_at is not null
      or created_at < now() - interval '90 days';
  $$
);
