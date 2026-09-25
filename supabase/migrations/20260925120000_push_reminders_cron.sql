-- =====================================================================
-- LAZYSHIFT — Migration: hourly cron job for send-shift-reminders
-- Calls the Edge Function every hour on the hour via pg_net, with the
-- Bearer token read from Vault (PUSH_REMINDER_CRON_SECRET — the real
-- value lives in Vault and in the function's secrets, NOT in this file).
-- cron.schedule with an existing job name replaces that job, so
-- re-running this migration does not create duplicates.
-- =====================================================================

select cron.schedule(
  'send-shift-reminders-hourly',
  '0 * * * *',
  $$
  select net.http_post(
    url := 'https://tmkrbnkztmohfoohbgfy.supabase.co/functions/v1/send-shift-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'PUSH_REMINDER_CRON_SECRET'
      )
    ),
    body := '{}'::jsonb
  ) as request_id;
  $$
);
