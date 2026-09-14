-- MDS19 / GeneX — prediction history schema
--
-- Owner: whoever administers the Supabase project (backend/infra).
-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- No application code depends on this file directly — the frontend talks to
-- these tables through supabase-js once they exist.
--
-- Architecture: the frontend writes here directly after a successful call to
-- the FastAPI /api/predict endpoint. FastAPI is unaware this exists — no
-- backend code changes are required for this feature.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

create table if not exists predictions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  created_at    timestamptz not null default now(),
  filename      text,
  image_path    text,        -- path inside the "he-images" storage bucket
  model_version text,
  status        text not null default 'complete'
);

create table if not exists prediction_spots (
  id             uuid primary key default gen_random_uuid(),
  prediction_id  uuid not null references predictions(id) on delete cascade,
  spot_index     int not null,
  x              double precision not null,
  y              double precision not null,
  expression     jsonb not null   -- { "GENE_NAME": value, ... }
);

create table if not exists prediction_genes (
  id               uuid primary key default gen_random_uuid(),
  prediction_id    uuid not null references predictions(id) on delete cascade,
  gene_name        text not null,
  mean_expression  double precision not null,
  rank             int not null
);

create index if not exists prediction_spots_prediction_id_idx
  on prediction_spots(prediction_id);
create index if not exists prediction_genes_prediction_id_idx
  on prediction_genes(prediction_id);
create index if not exists predictions_user_id_created_at_idx
  on predictions(user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 2. Row Level Security
--
-- Replaces the permissive `using (true)` dev policy noted in the project
-- handoff — every row is scoped to the owning user.
-- ---------------------------------------------------------------------------

alter table predictions       enable row level security;
alter table prediction_spots  enable row level security;
alter table prediction_genes  enable row level security;

create policy "predictions: owner select"
  on predictions for select
  using (auth.uid() = user_id);

create policy "predictions: owner insert"
  on predictions for insert
  with check (auth.uid() = user_id);

create policy "predictions: owner delete"
  on predictions for delete
  using (auth.uid() = user_id);

-- Child tables have no user_id column of their own — ownership is checked by
-- joining back to the parent prediction.

create policy "prediction_spots: owner select"
  on prediction_spots for select
  using (
    exists (
      select 1 from predictions p
      where p.id = prediction_spots.prediction_id
        and p.user_id = auth.uid()
    )
  );

create policy "prediction_spots: owner insert"
  on prediction_spots for insert
  with check (
    exists (
      select 1 from predictions p
      where p.id = prediction_spots.prediction_id
        and p.user_id = auth.uid()
    )
  );

create policy "prediction_genes: owner select"
  on prediction_genes for select
  using (
    exists (
      select 1 from predictions p
      where p.id = prediction_genes.prediction_id
        and p.user_id = auth.uid()
    )
  );

create policy "prediction_genes: owner insert"
  on prediction_genes for insert
  with check (
    exists (
      select 1 from predictions p
      where p.id = prediction_genes.prediction_id
        and p.user_id = auth.uid()
    )
  );

-- No update policy on any table — a saved prediction is immutable; deleting
-- a `predictions` row cascades to its spots/genes.

-- ---------------------------------------------------------------------------
-- 3. Storage — full-resolution uploaded H&E images
--
-- Create the bucket via Dashboard → Storage → New bucket → name "he-images",
-- Public: OFF. Then run the policies below (Storage policies live in
-- storage.objects, scoped by this bucket's name).
--
-- Frontend uploads to path: {user_id}/{prediction_id}.<ext>
-- so the first path segment doubles as the ownership check.
-- ---------------------------------------------------------------------------

create policy "he-images: owner select"
  on storage.objects for select
  using (
    bucket_id = 'he-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "he-images: owner insert"
  on storage.objects for insert
  with check (
    bucket_id = 'he-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "he-images: owner delete"
  on storage.objects for delete
  using (
    bucket_id = 'he-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---------------------------------------------------------------------------
-- 4. What the frontend needs from you after running this
-- ---------------------------------------------------------------------------
-- - Project URL and anon/public key (Dashboard → Project Settings → API)
--   → these become NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY
--   in the frontend's .env.local. The anon key is safe to expose client-side;
--   RLS above is what actually protects the data.
-- - Confirm email/password auth is enabled: Dashboard → Authentication →
--   Providers → Email (on by default, just confirm "Confirm email" setting
--   matches what you want for a demo — off is simpler for a pitch).
-- - Confirm the "he-images" bucket exists (step 3) before the frontend tries
--   to upload to it.
