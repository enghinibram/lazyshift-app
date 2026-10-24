-- =====================================================================
-- LAZYSHIFT — Migration A2: backfill public.users for existing accounts
-- auth.users rows with no public.users row: people who signed up but never
-- opened the app while signed in, so the old client never created their
-- row. They never used a trial.
--
-- They get a fresh 30-day trial from the day this runs (now() + 30 days).
-- Rows that already exist are not touched and keep their own
-- trial_ends_at.
--
-- Must run before Migration B: after B the old client can no longer
-- create these rows itself.
-- =====================================================================

insert into public.users (id, email, is_pro, trial_ends_at)
select au.id, lower(au.email), false, now() + interval '30 days'
  from auth.users au
 where not exists (select 1 from public.users pu where pu.id = au.id);
