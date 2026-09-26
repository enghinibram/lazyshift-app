-- =====================================================================
-- LAZYSHIFT — Migration: pdf_subscribers
-- Emails collected by the "free PDF exports" modal (app.js,
-- savePdfEmailToSupabase). app.js was already writing here, but the
-- table did not exist, so every email was silently lost.
--
-- Access model:
--   anon          → plain INSERT only. Re-registering an existing email
--                   fails with 23505 (unique violation), which app.js
--                   treats as success — the email is already stored.
--   service_role  → full access (bypasses RLS) — the only way to read.
-- Upserts are deliberately NOT supported: any ON CONFLICT clause (even
-- DO NOTHING) needs anon SELECT on the table, and DO UPDATE additionally
-- needs UPDATE — either would let anyone read the email list via the API.
-- =====================================================================

create table if not exists public.pdf_subscribers (
  email         text primary key,
  registered_at timestamptz not null default now(),
  -- Basic sanity limits so the anon endpoint can't be used to store
  -- arbitrary junk (the client already requires an "@").
  constraint pdf_subscribers_email_format
    check (length(email) <= 320 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

alter table public.pdf_subscribers enable row level security;

-- Defense in depth on top of RLS: anon/authenticated get INSERT only.
revoke all on table public.pdf_subscribers from anon, authenticated;
grant insert on table public.pdf_subscribers to anon;

drop policy if exists "pdf_subscribers_anon_insert" on public.pdf_subscribers;
create policy "pdf_subscribers_anon_insert" on public.pdf_subscribers
  for insert to anon
  with check (true);
-- No SELECT / UPDATE / DELETE policies: with RLS on, those are denied
-- for every role except service_role.
