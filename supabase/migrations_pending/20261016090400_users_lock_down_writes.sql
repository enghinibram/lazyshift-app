-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
-- NOT APPLIED YET — DO NOT APPLY THIS MIGRATION YET.
-- It lives in supabase/migrations_pending/ on purpose: `supabase db push`
-- only reads supabase/migrations/, so it can't be applied by mistake.
--
-- To apply it later (after the client that no longer inserts into
-- public.users is deployed and every open tab has picked it up):
--   1. run supabase/verify/users_access.sql and check the results;
--   2. git mv this file back to supabase/migrations/ (keep its name);
--   3. supabase db push.
-- Undo: supabase/rollback/users_access_rollback.sql
-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

-- =====================================================================
-- LAZYSHIFT — Migration B: clients can no longer write public.users
-- Before: anon and authenticated had INSERT and UPDATE on every column,
-- and the RLS policies only checked auth.uid() = id — so any signed-in
-- user could set is_pro / premium_expires / trial_ends_at on their own row
-- or insert it with is_pro = true.
--
-- The only client write was the first-login INSERT in auth.js (id, email,
-- trial_ends_at), now done by the auth.users trigger (Migration A). No
-- client code updates the row, so no column-level UPDATE is granted back.
--
-- Revoking at table level also revokes every column privilege on the
-- table, so no column grant survives. service_role (webhook, Edge
-- Function) and the table owner (trigger function) are unaffected.
--
-- PRECONDITION: Migration A (trigger) and A2 (backfill) are applied.
-- Without them, sign-ups on the old client would get no users row.
-- =====================================================================

revoke all on table public.users from public, anon, authenticated;
grant select on table public.users to authenticated;
grant all on table public.users to service_role;

alter table public.users enable row level security;

-- Pointless without INSERT/UPDATE grants; dropped so they can't silently
-- start working again if a broad grant is ever re-added.
drop policy if exists "Users can insert own record" on public.users;
drop policy if exists "Users can update own record" on public.users;
-- Kept: "Users can read own record" (SELECT, auth.uid() = id).
