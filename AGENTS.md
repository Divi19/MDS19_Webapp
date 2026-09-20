# Project workflow

- Run frontend commands from `frontend/`; the repository root has no `package.json`.
- Frontend verification: `cd frontend && npm test && npm run lint && npm run build`.
- Backend verification: `cd backend && python -m pytest -q`.
- Backend local setup uses `backend/requirements-dev.txt`.
- `MODE=demo` must remain visibly synthetic. `MODE=real` is limited to HER2-positive breast H&E inputs with microns-per-pixel metadata.
- Preserve raw model-scale predicted values. Visualization scaling must never overwrite response values.
- Use `prediction tiles`, `retrieval support`, and `predicted-expression domains`; do not describe outputs as measured spots, confidence, cell types, diagnosis, or biomarkers.
- Apply Supabase migrations in numeric order. Expanded history depends on `0002_research_runs.sql`.
