# MDS19 Web Application

Web interface for predicting spatial gene expression from H&E histology images.

## Stack
- Frontend: Next.js (TypeScript, Tailwind)
- Backend: FastAPI (Python 3.11)
- Database: Supabase (PostgreSQL)
- Packaging: Docker

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