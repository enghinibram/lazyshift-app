-- =====================================================================
-- LAZYSHIFT — Migration: Push notifications (reminder before shift)
-- Adapted from calculator-ture (20260903015736_push_reminders.sql).
-- Adds: shift start time + timezone per user, push_subscriptions (with
-- RLS), push_reminder_log for dedupe, and the pg_cron/pg_net extensions.
--
-- NOT included here: the hourly cron.schedule job. It depends on the
-- send-shift-reminders Edge Function being deployed and on the
-- PUSH_REMINDER_CRON_SECRET secret existing in Vault — add it in a
-- separate migration once both are in place.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) user_settings
-- app.js already reads/writes this table (saveSettings/loadSettings),
-- but it did not exist in this project. Created here with the exact
-- columns app.js uses, so the ALTERs below always have a target.
-- ---------------------------------------------------------------------
create table if not exists public.user_settings (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  start_date  date,
  tura_type   text,
  co_days     text,
  cm_days     text,
  custom_days text,
  custom_ore  integer,
  updated_at  timestamptz not null default now()
);
alter table public.user_settings enable row level security;

drop policy if exists "user_settings_select_own" on public.user_settings;
create policy "user_settings_select_own" on public.user_settings
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "user_settings_insert_own" on public.user_settings;
create policy "user_settings_insert_own" on public.user_settings
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "user_settings_update_own" on public.user_settings;
create policy "user_settings_update_own" on public.user_settings
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Shift start time (applied to every working day of the user's
-- pattern). Without it the "X hours before" reminder cannot be
-- computed — users who leave it empty get no notifications.
alter table public.user_settings
  add column if not exists shift_start_time time;

-- IANA timezone name (e.g. 'Europe/London'), set from the browser via
-- Intl.DateTimeFormat().resolvedOptions().timeZone. LazyShift users are
-- spread across countries, so unlike calculator-ture the Edge Function
-- cannot assume a single fixed timezone. Not validated here (a CHECK
-- can't query pg_timezone_names) — the Edge Function must skip rows
-- with an unknown/null timezone.
alter table public.user_settings
  add column if not exists timezone text;

-- ---------------------------------------------------------------------
-- 2) push_subscriptions — one row per user + device (browser endpoint).
-- Written by the client (upsert onConflict 'user_id,endpoint'), read by
-- the Edge Function with service_role (bypasses RLS).
-- ---------------------------------------------------------------------
create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  endpoint   text not null,
  p256dh     text not null,
  auth_key   text not null,
  created_at timestamptz not null default now(),
  constraint push_subscriptions_user_endpoint_key unique (user_id, endpoint)
);
alter table public.push_subscriptions enable row level security;

-- Upsert needs select + insert + update; delete lets a user unsubscribe
-- a device.
drop policy if exists "push_subscriptions_select_own" on public.push_subscriptions;
create policy "push_subscriptions_select_own" on public.push_subscriptions
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "push_subscriptions_insert_own" on public.push_subscriptions;
create policy "push_subscriptions_insert_own" on public.push_subscriptions
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "push_subscriptions_update_own" on public.push_subscriptions;
create policy "push_subscriptions_update_own" on public.push_subscriptions
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "push_subscriptions_delete_own" on public.push_subscriptions;
create policy "push_subscriptions_delete_own" on public.push_subscriptions
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------
-- 3) push_reminder_log — audit / dedupe: at most one reminder per user
-- per shift day, no matter how many hourly cron runs see the same shift
-- inside the 2-3h window. shift_date is the date in the USER's timezone.
-- ---------------------------------------------------------------------
create table if not exists public.push_reminder_log (
  user_id    uuid not null references auth.users(id) on delete cascade,
  shift_date date not null,
  sent_at    timestamptz not null default now(),
  primary key (user_id, shift_date)
);
alter table public.push_reminder_log enable row level security;
-- No policies — only service_role (used by the Edge Function) can
-- read/write; RLS blocks any client access by default.

-- ---------------------------------------------------------------------
-- 4) Extensions for native Postgres cron + HTTP calls.
-- ---------------------------------------------------------------------
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;
