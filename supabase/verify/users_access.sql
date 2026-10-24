-- =====================================================================
-- LAZYSHIFT — verification queries for the public.users lockdown.
-- Read-only. Run in the Supabase SQL editor after each rollout step;
-- the expected result after the full rollout is noted above each query.
-- =====================================================================

-- 1) RLS policies on public.users
--    Expected: only "Users can read own record" (SELECT).
select policyname, cmd, roles, qual, with_check
  from pg_policies
 where schemaname = 'public' and tablename = 'users'
 order by policyname;

-- 2) RLS enabled on users and pending_entitlements
--    Expected: both true.
select relname, relrowsecurity
  from pg_class
 where oid in ('public.users'::regclass, 'public.pending_entitlements'::regclass);

-- 3) Table privileges for client roles
--    Expected: authenticated → SELECT only; anon → no rows;
--    pending_entitlements → no rows for anon/authenticated.
select table_name, grantee, privilege_type
  from information_schema.role_table_grants
 where table_schema = 'public'
   and table_name in ('users', 'pending_entitlements')
   and grantee in ('anon', 'authenticated', 'PUBLIC')
 order by table_name, grantee, privilege_type;

-- 4) Column privileges for client roles
--    Expected: authenticated → SELECT on each column; no INSERT/UPDATE
--    anywhere; anon → no rows.
select grantee, column_name, privilege_type
  from information_schema.column_privileges
 where table_schema = 'public' and table_name = 'users'
   and grantee in ('anon', 'authenticated', 'PUBLIC')
 order by grantee, privilege_type, column_name;

-- 5) Who can execute the functions
--    Expected: get_user_id_by_email → service_role true, others false.
--              handle_auth_user_change → false for anon/authenticated.
select f.fn,
       has_function_privilege('anon',          f.fn, 'execute') as anon,
       has_function_privilege('authenticated', f.fn, 'execute') as authenticated,
       has_function_privilege('service_role',  f.fn, 'execute') as service_role
  from (values ('public.get_user_id_by_email(text)'),
               ('public.handle_auth_user_change()')) as f(fn);

-- 6) The trigger function is SECURITY DEFINER with an empty search_path
--    Expected: prosecdef = true, proconfig = {search_path=""}.
select proname, prosecdef, proconfig, pg_get_userbyid(proowner) as owner
  from pg_proc
 where oid = 'public.handle_auth_user_change()'::regprocedure;

-- 7) Triggers on auth.users
--    Expected: on_auth_user_created and on_auth_user_email_confirmed, enabled ('O').
select tgname, tgenabled, pg_get_triggerdef(oid) as definition
  from pg_trigger
 where tgrelid = 'auth.users'::regclass and not tgisinternal;

-- 8) Every auth user has a public.users row
--    Expected: 0.
select count(*) as auth_users_without_row
  from auth.users au
 where not exists (select 1 from public.users pu where pu.id = au.id);

-- 9) Rows that look self-granted under the old permissions — review by hand.
--    is_pro without any Lemon Squeezy subscription, or a trial longer
--    than 30 days after account creation.
--    Best run BEFORE the backfill (A2): afterwards every backfilled
--    account also matches the trial rule. Backfilled rows are easy to
--    spot — they all share the exact same trial_ends_at (now() is fixed
--    for the whole backfill statement).
select pu.id, pu.email, pu.is_pro, pu.premium_expires, pu.trial_ends_at,
       pu.lemon_squeezy_subscription_id, au.created_at
  from public.users pu
  join auth.users au on au.id = pu.id
 where (pu.is_pro and pu.lemon_squeezy_subscription_id is null)
    or pu.trial_ends_at > au.created_at + interval '31 days'
 order by au.created_at desc;

-- 10) Pending entitlements not yet applied
select id, email, event, is_pro, premium_expires, event_updated_at, created_at
  from public.pending_entitlements
 where applied_at is null
 order by created_at desc;
