-- MDS19 / GeneX — tissue-type classifier columns (tissue-v1)
--
-- Owner: whoever administers the Supabase project (backend/infra).
-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor → New query),
-- after 0001–0003. Safe to re-run.
--
-- Context: see backend/app/services/tissue.py. Each prediction spot can now
-- carry a predicted tissue type (5 display classes, Cancer = invasive + in
-- situ), and each prediction a per-class summary. Every column is nullable:
-- rows saved before this migration, or predictions made with the classifier
-- off, simply read back as null and the frontend hides the tissue UI.

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------

alter table prediction_spots
  add column if not exists tissue_class      text,
  add column if not exists tissue_confidence real,
  add column if not exists tissue_probs      jsonb;   -- { "Cancer": p, "Immune infiltrate": p, ... }

alter table predictions
  add column if not exists tissue_model_version text,  -- e.g. "tissue-v1"
  add column if not exists tissue_summary       jsonb; -- { "Cancer": { "count": n, "fraction": f }, ... }

-- ---------------------------------------------------------------------------
-- 2. Row Level Security — nothing to add.
--
-- The 0001 policies are row-level (owner select/insert/delete on predictions,
-- and parent-ownership checks on prediction_spots), so they already govern
-- these new columns. No new table, bucket or env var.
-- ---------------------------------------------------------------------------
