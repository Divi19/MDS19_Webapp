-- MDS19 / GeneX — how a saved prediction's spot grid maps to image pixels
--
-- Owner: whoever administers the Supabase project (backend/infra).
-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor → New query),
-- after 0001–0004. Safe to re-run.
--
-- Context: each spot's x/y are tile grid indices. Tile (x, y) covers
-- [x*stride_px, x*stride_px + tile_px) in original-image pixels. The local
-- MclSTExp backend and the old v7 Modal model both tile at 224/224;
-- v16-core tiles at 224/290. History needs the values to redraw a reopened
-- run in the right place. Both columns are nullable: rows saved before this
-- migration (or from a model that does not report them) read back as null
-- and the frontend falls back to 224/224, or to a known model_version's own
-- tiling (frontend/src/lib/tiling.ts).

alter table predictions
  add column if not exists tile_px   integer,  -- tile size, original-image pixels
  add column if not exists stride_px integer;  -- tile spacing, original-image pixels

-- Make the API see the new columns immediately.
notify pgrst, 'reload schema';

-- Row Level Security: nothing to add. The 0001 policies are row-level, so
-- they already govern these columns.
