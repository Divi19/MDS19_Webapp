-- MDS19 / GeneX — user profile schema
--
-- Owner: whoever administers the Supabase project (backend/infra).
-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor → New query),
-- after 0001_predictions_history.sql.
--
-- Architecture: same pattern as predictions — the frontend reads/writes this
-- table directly via supabase-js, no backend involvement. There is no trigger
-- creating a row on signup; the frontend upserts on first save, and treats a
-- missing row as "no profile set yet" rather than an error.

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------

create table if not exists profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  display_name  text,
  institution   text,
  role          text,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. Row Level Security — a user can only ever see/edit their own row.
-- ---------------------------------------------------------------------------

alter table profiles enable row level security;

create policy "profiles: owner select"
  on profiles for select
  using (auth.uid() = id);

create policy "profiles: owner insert"
  on profiles for insert
  with check (auth.uid() = id);

create policy "profiles: owner update"
  on profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- No delete policy — a profile row is cleaned up automatically via the
-- `on delete cascade` when the auth.users row itself is deleted.

-- ---------------------------------------------------------------------------
-- 3. What the frontend needs from you after running this
-- ---------------------------------------------------------------------------
-- Nothing beyond what 0001 already required — this reuses the same Supabase
-- project, URL, and anon key. No new bucket, no new env vars.
