# GeneX Spatial Expression Research Workspace

GeneX predicts a HER2-positive breast tissue expression panel from H&E images with the mclSTExp retrieval model and exposes image QC, retrieval support, spatial statistics, predicted-expression domains, ROI comparisons, pathway enrichment, provenance, and interoperable exports.

## Scientific scope

GeneX is for research use only. Values are model-scale predictions, not measured spatial transcriptomics, counts, diagnoses, cell types, biomarkers, laboratory-equivalent results, or calibrated confidence. The current real checkpoint and 785-gene reference panel are limited to HER2-positive breast H&E tissue.

## Repository layout

- `backend/`: FastAPI prediction, analysis, pathway, and export APIs
- `frontend/`: Next.js scientific workspace
- `supabase/`: authenticated immutable history migrations

There is no root `package.json`; run npm commands from `frontend/`.

## Backend

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements-dev.txt
cp ../.env.example .env
uvicorn app.main:app --reload --port 8000
```

The default `MODE=demo` is explicit and returns synthetic values. Real mode requires:

```dotenv
MODE=real
MODEL_DATA_ROOT=
MODEL_CHECKPOINT_PATH=
MAX_CONCURRENT_PREDICTIONS=1
```

When the two model paths are blank, real mode resolves `backend/model_data/webapp_database`, downloads the configured archive if required, validates all consumed artifacts, and uses `best_0.pt`. Set absolute overrides for managed deployments.

The real prediction request requires an H&E image, explicit HER2-positive breast confirmation, and microns-per-pixel metadata. Image, scale, tissue, and resource failures return structured 4xx responses.

Run backend verification with:

```bash
cd backend
python -m pytest -q
```

## Frontend

```bash
cd frontend
npm install
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`. The frontend calls `NEXT_PUBLIC_API_URL`, which defaults to `http://localhost:8000`.

Run frontend verification with:

```bash
cd frontend
npm test
npm run lint
npm run build
```

## Supabase history

Apply migrations in order:

1. `supabase/migrations/0001_predictions_history.sql`
2. `supabase/migrations/0002_research_runs.sql`

Create the private `he-images` bucket, enable email/password authentication, and set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in `frontend/.env.local`.

The second migration stores each expanded response atomically through an authenticated, security-invoker RPC. Ownership comes from `auth.uid()` and existing RLS. Legacy records remain readable but are marked incompatible with the expanded workspace.

## Research outputs

- H&E-linked raw gene, predicted-expression domain, and retrieval-support layers
- Image/tissue QC and declared-scope applicability
- Moran's I with empirical p-values and Benjamini-Hochberg q-values
- Versioned PCA/K-means predicted-expression domains and domain-vs-rest marker contrasts
- Exploratory ROI comparisons with spatial-block permutation where feasible
- Versioned g:Profiler enrichment using the model panel as background
- ZIP export with raw matrix CSV, summaries, ROI GeoJSON, provenance JSON, full response JSON, print-ready HTML report, and H5AD-compatible output
- Current tissue-view PNG

Within-section tests operate on predicted, spatially autocorrelated tiles and do not substitute for biological replication.
