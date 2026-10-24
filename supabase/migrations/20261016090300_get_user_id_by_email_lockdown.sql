-- =====================================================================
-- LAZYSHIFT — Migration C: get_user_id_by_email is service_role only
-- It was executable by anon, so anyone with the public anon key could map
-- an email to a user id (account enumeration). Its only caller is
-- api/lemonsqueezy-webhook.js, which uses the service key. Nothing in the
-- client calls it. Independent of the other migrations.
-- =====================================================================

revoke execute on function public.get_user_id_by_email(text) from public, anon, authenticated;
grant execute on function public.get_user_id_by_email(text) to service_role;
