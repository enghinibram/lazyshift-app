# Pending migrations — not applied to production

Files here are **not** picked up by `supabase db push` (it only reads
`supabase/migrations/`). Each one waits for a deliberate step.

| File | Waits for |
|---|---|
| `20261016090400_users_lock_down_writes.sql` (Migration B) | the client that only reads `public.users` (no insert) deployed and live; then run `supabase/verify/users_access.sql` |

Already applied to production (in `supabase/migrations/`):
`20261015090000_users_ls_updated_at`, `20261016090000_pending_entitlements`,
`20261016090100_users_signup_trigger` (A), `20261016090200_users_backfill` (A2),
`20261016090300_get_user_id_by_email_lockdown` (C).

To apply one: move it back to `supabase/migrations/` with the same name, then
`supabase db push`. Rollback for B: `supabase/rollback/users_access_rollback.sql`.
