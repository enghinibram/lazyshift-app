-- =====================================================================
-- LAZYSHIFT — Migration A: create public.users server-side on sign-up
-- Until now auth.js inserted the row itself (id, email, trial_ends_at),
-- which required anon/authenticated INSERT on public.users — and let any
-- user pick their own trial_ends_at or is_pro. From now on:
--   * AFTER INSERT on auth.users  → row with is_pro = false and a 30-day
--     trial, in the same transaction as the sign-up.
--   * once the email is confirmed (at insert, or when email_confirmed_at
--     is first set) → apply the newest unapplied pending_entitlements row
--     for that email.
-- Pending entitlements wait for confirmation on purpose: otherwise anyone
-- could sign up with a buyer's email and inherit their payment before
-- proving they own the address.
--
-- Safe to apply while the old client is live: the trigger runs before the
-- client ever gets a session, so the old auth.js finds the row on its
-- first SELECT and never reaches its own INSERT.
--
-- A failing trigger would abort the sign-up itself, so the row insert uses
-- NOT EXISTS (no dependency on a unique constraint) and the pending part
-- is wrapped in an exception handler that only logs a warning.
-- =====================================================================

create or replace function public.handle_auth_user_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  p record;
begin
  insert into public.users (id, email, is_pro, trial_ends_at)
  select new.id, lower(new.email), false, now() + interval '30 days'
  where not exists (select 1 from public.users where id = new.id);

  if new.email_confirmed_at is not null and new.email is not null then
    begin
      select pe.is_pro, pe.premium_expires, pe.subscription_id, pe.event_updated_at
        into p
        from public.pending_entitlements pe
       where pe.email = lower(new.email)
         and pe.applied_at is null
       order by pe.event_updated_at desc
       limit 1;

      if found then
        -- Same ordering rule as the webhook's conditional PATCH.
        update public.users u
           set is_pro                        = p.is_pro,
               premium_expires               = p.premium_expires,
               lemon_squeezy_subscription_id = coalesce(p.subscription_id, u.lemon_squeezy_subscription_id),
               ls_updated_at                 = p.event_updated_at
         where u.id = new.id
           and (u.ls_updated_at is null or u.ls_updated_at < p.event_updated_at);

        update public.pending_entitlements
           set applied_at = now(), applied_user_id = new.id
         where email = lower(new.email)
           and applied_at is null;
      end if;
    exception when others then
      raise warning 'handle_auth_user_change: pending entitlement for % not applied: %', new.id, sqlerrm;
    end;
  end if;

  return new;
end;
$$;

-- Trigger-only function: nobody should be able to call it directly.
revoke all on function public.handle_auth_user_change() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_auth_user_change();

drop trigger if exists on_auth_user_email_confirmed on auth.users;
create trigger on_auth_user_email_confirmed
  after update of email_confirmed_at on auth.users
  for each row
  when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
  execute function public.handle_auth_user_change();
