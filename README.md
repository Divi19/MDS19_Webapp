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