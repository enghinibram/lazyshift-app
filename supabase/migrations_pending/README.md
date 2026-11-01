# Pending migrations — not applied to production

Files here are **not** picked up by `supabase db push` (it only reads
`supabase/migrations/`). Each one waits for a deliberate step.

| File | Waits for |
|---|---|
| `20261016090400_users_lock_down_writes.sql` (Migration B) | the client that only reads `public.users` (no insert) deployed and live; then run `supabase/verify/users_access.sql` |
| `20261101090000_pending_entitlements_minimal.sql` (N12) | nothing — but it must be applied **before** the webhook that stops writing `payload` is deployed. See below. |

Already applied to production (in `supabase/migrations/`):
`20261015090000_users_ls_updated_at`, `20261016090000_pending_entitlements`,
`20261016090100_users_signup_trigger` (A), `20261016090200_users_backfill` (A2),
`20261016090300_get_user_id_by_email_lockdown` (C).

To apply one: move it back to `supabase/migrations/` with the same name, then
`supabase db push`. Rollback for B: `supabase/rollback/users_access_rollback.sql`.

## N12 — minimise and purge `pending_entitlements`

Migration: `20261101090000_pending_entitlements_minimal.sql`.
Verify: `supabase/verify/pending_entitlements.sql`.
Rollback: `supabase/rollback/pending_entitlements_rollback.sql`.
Account deletion: `supabase/runbook/account_deletion.sql`.

Why the order matters: on production `payload` is still `NOT NULL`. The new
webhook no longer sends it, so if it went live first, every payment without a
matching account would fail with 500 and Lemon Squeezy would retry it. The
migration makes the column nullable, and the **old** webhook keeps working
after it (the daily job clears whatever payload it still writes), so
migration → webhook is safe in that order and only in that order.

### Order

1. **Before** — in the SQL editor, run queries 1–4 of the verify file and note
   the results: both extensions present; the counts from query 2; `payload`
   is_nullable = `NO`; no `purge-pending-entitlements-daily` job yet.
2. **Apply** — `git mv` the migration to `supabase/migrations/` (same name),
   then `supabase db push`. If Migration B is still pending, its timestamp is
   earlier than this one; when B is applied later, `supabase db push` will
   ask for `--include-all` — that is expected.
3. **After** — run queries 2–4, 6 and 7 again. Expected: `with_payload = 0`,
   `applied = 0`, `unapplied` the same as before; `payload` is_nullable =
   `YES`; one active job with schedule `17 3 * * *`; query 6 returns no rows;
   query 7 shows `payload_cleared = true` on every row.
4. **Deploy the webhook** — merge the PR (Vercel deploys `main`). Do not
   merge before step 3 is green.
5. **Next day** — run query 5: the purge ran with status `succeeded`, and
   query 2 shows `unapplied_over_90_days = 0`. After the first payment
   without an account, query 7 shows the new row with `payload_cleared =
   true` even before the job runs (the new webhook sends no payload).
6. **Then** — update `privacy.html` (the sentences are listed in the PR) and
   add `supabase/runbook/account_deletion.sql` to the deletion procedure.
