# MDS19 Web Application

Web interface for predicting spatial gene expression from H&E histology images.

## Stack
- Frontend: Next.js (TypeScript, Tailwind)
- Backend: FastAPI (Python 3.11)
- Database: Supabase (PostgreSQL)
- Packaging: Docker

## Local Setup

1. **Clone and install.**

       git clone <repo-url>
       cd MDS19_Webapp
       cd frontend && npm install
       cd ../backend && pip install -r requirements.txt

2. **Set up environment files.**

       cp .env.example backend/.env            # from repo root
       cp frontend/.env.example frontend/.env.local

3. **Get real values.** Ask Brandon privately for the Supabase URL/keys (and the
   Modal inference URLs, if you need the real model rather than the dummy
   predictor). Never share keys in group chats, screenshots, or commit them —
   `.env` / `.env.local` are gitignored on purpose.

4. **Run it.**

       # Backend
       cd backend
       uvicorn app.main:app --reload --port 8000

       # Frontend (separate terminal)
       cd frontend
       npm run dev

   Frontend: http://localhost:3000 — API docs: http://localhost:8000/docs

5. **Workflow.** Branch off `main`, test your change locally (including sign-in
   and History if it touches Supabase), and only merge into `main` after it's
   confirmed working. Full rules are in [`CLAUDE.md`](./CLAUDE.md) — read it
   before starting any task.

6. **Before starting new work:** run `git pull` on `main` first, so you have
   the latest `CLAUDE.md` and code.

## Quick start

    # Backend
    cd backend
    python3 -m venv venv && source venv/bin/activate
    pip install -r requirements.txt
    cp ../.env.example .env        # then fill in values
    uvicorn app.main:app --reload --port 8000

    # Frontend (separate terminal)
    cd frontend
    npm install
    npm run dev

Frontend: http://localhost:3000
API docs: http://localhost:8000/docs

## Tissue classifier (tissue-v1)

Each prediction tile can also carry a predicted **tissue type**. When it
does, a **Tissue** tab appears next to Clusters / Genes / Grad-CAM:

The tissue types are context for the predicted expression, not a diagnosis.

- **Map:** one colour per class. A legend below the map gives counts and
  percentages on hover, and hovering or focusing a class highlights it.
  **Click a class to pin it**: its tiles are coloured by the selected gene,
  scaled from the lowest to the highest of those tiles (the legend shows the
  range), and every other tile fades. This shows where within, say, the
  tumour a gene is highest. Click the pinned class (×) to unpin. The pin is
  shared with the *Genes higher in* picker, and hovering a row of the
  *[gene] by tissue type* section highlights that class on the map. The
  tooltip shows raw predicted expression, the same scale as the panel.
  Uncertain tiles (top class below 50%) are faded with a dashed outline and
  marked "uncertain" in the tooltip.
- **Gene picker** in the header, as on the Genes tab. Picking a gene keeps you
  on the Tissue tab and updates the bottom card.
- **Opacity slider** (and *Show image*) keeps the H&E readable.
- **Right column (Tissue tab only):** *Tissue Analysis* replaces Cluster
  Analysis, which comes back on every other tab with any pathway results
  kept. It has two tabs, **Expression** (default) and **Composition**.

  **Expression tab:**
  - *[gene] by tissue type*: the selected gene's mean predicted expression
    per type, with a line showing where the middle half of that type's tiles
    fall. A difference smaller than the lines is within normal tile-to-tile
    variation. Types with fewer than 10 tiles are greyed out ("too few").
    Hover a row to preview that type on the map; **click it to lock** it
    (outlined, other rows fade; click again to unlock).
  - *Genes higher in [type]*: pick any type with at least 10 tiles (and at
    least 10 other tiles). Lists up to 10 genes, shown as plain means (type vs
    all other tiles), or says none are clearly higher. Click one to select
    it. A gene qualifies on two checks:
    - **relative:** after subtracting each tile's overall level (its mean
      over all genes), it is still higher by at least the typical tile-to-tile
      spread (pooled standard deviation). Dense tumour tiles get higher
      predictions for almost every gene; without this, nearly the whole panel
      would read "higher in Cancer";
    - **plain:** the means shown differ by at least half their own spread,
      so the numbers on screen agree.
  - *Expression groups within [type]*: the expression clusters that the
    picked type's tiles fall into (clusters with 10+ of them). Hover a group
    to see just its tiles on the map. With two or more groups, it lists the
    genes higher in each of the two largest (same rule). Example: tumour tiles
    split into two clusters, one higher in immune genes (PTPRC, CD3D).

  **Composition tab:** the whole section ("Cancer 74% · Connective 23% · …")
  and each expression cluster, with its tissue name, tile count, a stacked
  bar and the counts written out ("107 Cancer · 1 Adipose"). Hover a cluster
  to see just its tiles on the map; **click it to lock** that view (outlined
  card, other cards fade; click again or leave the tab to unlock). Only one
  lock at a time: locking a cluster releases a tissue-type lock and vice
  versa.
- **Bottom card:** *Tissue breakdown*: one tile per tissue type with its tile
  count and share, built like the Cluster breakdown tiles on the other tabs.
  Types with fewer than 10 tiles say "too few" (why the panel greys them
  out). Click a tile to pin that type, shared with the legend and the
  *Genes higher in* picker.
- **Linked into the rest of the app** (only when the prediction has tissue
  types):
  - **Cluster names:** each cluster is named by its tiles' tissue types:
    "Cancer (95%)" when one type has 60%+ of its tiles, "Cancer + Connective"
    when two types each have 20%+, otherwise the plain "cluster N". Shown in
    Cluster Analysis, the Cluster breakdown tiles, the Composition tab, the
    map tooltip and the Clusters legend ("0 · Cancer"; the legend falls back to
    "cluster 0" if the named pills would need more rows).
  - **Gene list:** under each gene, the tissue type it is clearly highest in
    ("↑ Cancer", same rule as *Genes higher in*) or "no clear type". Hover
    for the numbers, including how they relate to the whole-slide value.
- **Export:** the Excel workbook adds an *Expression by tissue type* sheet
  (every gene's mean per class, plus tile counts) and a *Tiles* sheet (grid
  position, cluster, tissue type, confidence and the five class
  probabilities per tile) and a *Genes higher by tissue type* sheet (the
  panel's lists for every type with enough tiles).
- **Layout:** the map, header and bottom card are the same size as on the
  Genes tab.

- **What it is:** a logistic regression (numpy only) on the same H0-mini
  features the v7 expression model uses: the native 224 crop (1536-d) plus the
  672 context crop resized to 224 (1536-d). There is no new deep model.
- **Classes:** the model outputs 6 classes. Invasive cancer and cancer in situ
  are merged into one **Cancer** class because the model cannot separate them
  (in situ F1 0.06). The 5 classes shown are Cancer, Immune infiltrate, Breast
  glands, Connective tissue and Adipose tissue.
- **Training data:** HER2ST pathologist annotations: 3,157 labelled spots from
  8 patients, evaluated leave-one-patient-out.
- **Performance on unseen patients:**
  - Cancer vs non-cancer: 87.4% sensitivity, 81.8% specificity, 87.8%
    precision (cancer F1 0.876).
  - 5-class macro-F1 0.62.
  - Per-class F1: immune 0.47, glands 0.55, connective 0.59, adipose 0.63.
- **Limitations:**
  - HER2+ breast cancer only.
  - Research prototype, not for diagnosis.
  - Does not distinguish in situ from invasive cancer.
  - The figures above were measured on HER2ST spots, not on the app's 224 px
    grid tiles of arbitrary uploads.
  - Derivative of H0-mini (CC-BY-NC-ND 4.0): non-commercial use only.
- **Setup:**
  - Put `tissue_clf.npz` and `stage_config.json` in
    `backend/model_data/tissue_clf_v1/`. The folder is gitignored, like the
    expression bank.
  - `TISSUE_CLASSIFIER_ENABLED=false` turns the feature off.
  - With `ENCODER_BACKEND=densenet121`, the classifier computes its own
    H0-mini features. That needs `HF_TOKEN` (an account with access to the
    gated `bioptimus/H0-mini`) in `backend/.env`.
  - If anything is missing, the tissue fields are null, the toggle is hidden
    and expression is unaffected.
- **Database:** apply `supabase/migrations/0004_tissue_classifier.sql` so
  history saves the tissue fields. History still works without the migration,
  but the tissue fields are not saved.
- **Tests:**
  - Backend: `cd backend && pip install -r requirements-dev.txt && python -m pytest -q`
  - Frontend: `cd frontend && npm test`

## Current state
The API returns **dummy predictions**. The real model is not yet wired in.
Set `USE_DUMMY_PREDICTOR=false` once `MclSTExpPredictor` is implemented
in `backend/app/services/predictor.py`.

## Known TODOs
- [ ] Implement `MclSTExpPredictor`
- [ ] Replace development RLS policies before any public deployment
- [ ] Choose an API host (Render / Railway / Hugging Face Spaces)
- [ ] Wire Supabase persistence into the predict route
- [ ] Spatial heatmap visualisation
- [ ] SHAP explainability panel