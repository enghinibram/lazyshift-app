-- =====================================================================
-- LAZYSHIFT — verification queries for minimising pending_entitlements
-- (20261101090000_pending_entitlements_minimal).
-- Read-only. Run in the Supabase SQL editor before and after applying;
-- the expected result after the migration is noted above each query.
-- =====================================================================

-- 1) pg_cron and pg_net are installed (the migration needs pg_cron)
--    Expected before and after: two rows.
select extname, extversion
  from pg_extension
 where extname in ('pg_cron', 'pg_net');

-- 2) Row counts by state
--    Before: note the numbers.
--    After:  with_payload = 0, applied = 0; unapplied unchanged.
select count(*)                                       as total,
       count(*) filter (where payload is not null)    as with_payload,
       count(*) filter (where applied_at is not null) as applied,
       count(*) filter (where applied_at is null)     as unapplied,
       count(*) filter (where applied_at is null
                          and created_at < now() - interval '90 days') as unapplied_over_90_days
  from public.pending_entitlements;

-- 3) payload column is nullable
--    Before: NO.  After: YES.
select column_name, is_nullable
  from information_schema.columns
 where table_schema = 'public'
   and table_name   = 'pending_entitlements'
   and column_name  = 'payload';

-- 4) Purge job is scheduled
--    Before: no row.  After: one row, schedule '17 3 * * *', active true.
select jobid, jobname, schedule, active, command
  from cron.job
 where jobname = 'purge-pending-entitlements-daily';

-- 5) Purge job runs (check the day after applying)
--    Expected: status 'succeeded' on each run.
select d.start_time, d.status, d.return_message
  from cron.job_run_details d
  join cron.job j on j.jobid = d.jobid
 where j.jobname = 'purge-pending-entitlements-daily'
 order by d.start_time desc
 limit 5;

-- 6) Still locked down: no privileges for client roles
--    Expected before and after: no rows.
select grantee, privilege_type
  from information_schema.role_table_grants
 where table_schema = 'public'
   and table_name   = 'pending_entitlements'
   and grantee in ('anon', 'authenticated', 'PUBLIC');

-- 7) Unapplied rows hold only the fields the trigger needs
--    Expected after: payload null on every row.
select id, email, event, is_pro, premium_expires, subscription_id,
       event_updated_at, created_at, payload is null as payload_cleared
  from public.pending_entitlements
 where applied_at is null
 order by created_at desc;
