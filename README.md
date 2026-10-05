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

Each prediction spot can also carry a predicted **tissue type**, shown in the
Genes view under *Colour spots by → Tissue type*.

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