# Alternate Design Branch Handoff

This document describes exactly what changed on `alternate_design` relative to the original screenshot-linked implementation at commit `8815607` (`Replace top-12 gene table with the full ranked panel, paginated`). It is intended as an idea and implementation reference for selectively updating `main`; it is not a recommendation to merge the branch wholesale.

## 1. Branch facts

- Reference branch: `alternate_design`
- Baseline commit: `8815607`
- Branch-only commits after the baseline: 26 before this handoff document
- Changed files before this document: 49
- Approximate branch diff before this document: 7,053 insertions and 1,627 deletions
- Commit policy: every branch-only implementation commit contains 2–3 files
- Remote status: no branch changes were pushed during this work

Useful comparison commands:

```bash
git diff --stat 8815607..alternate_design
git diff --name-status 8815607..alternate_design
git log --oneline --reverse 8815607..alternate_design
```

## 2. What the original version did

At `8815607`, the repository matched the original three-column screenshot:

- Left: uploaded image and a paginated table ranked by mean predicted expression.
- Center: blank-axis dot map for client-created clusters or a selected gene.
- Right: fixed chatbot panel.
- Backend: FastAPI response containing `spots`, `top_genes`, and `model_version`.
- Real predictor code existed, but local defaults still selected `DummyPredictor`; model artifact startup and configured paths were disconnected.
- Client converted the backend matrix into its own display model.
- Each gene was min-max scaled independently for the map.
- Browser K-means used the 30 highest-mean genes and fixed `k=5`.
- High/Mid/Low meant rank tertiles, not validated expression thresholds.
- Chat was a keyword responder that claimed GeneCards/GO use without making those calls.
- Export showed a success toast but generated no file.
- Progress displayed internal stages that were not actually reported by the backend.
- Supabase history wrote an image, parent record, spots, and top genes in separate client-side requests.
- No test suite existed.

## 3. Product and scientific direction used on this branch

The alternate design deliberately changed the product claim:

- Scope is limited to HER2-positive breast H&E tissue.
- Values are described as `model-scale predicted expression`.
- Spatial units are called `prediction tiles`, not measured ST spots.
- Nearest-reference diagnostics are called `retrieval support`, not confidence or uncertainty.
- Clusters are called `predicted-expression domains`, not cell types or pathology classes.
- Outputs are research-use-only and explicitly not diagnosis, biomarkers, measured transcriptomics, laboratory equivalence, or calibrated confidence.
- The H&E image is the primary coordinate system; derived values are overlays.

These terminology and positioning changes can be adopted independently of the visual redesign.

## 4. Backend changes

### 4.1 Explicit real/demo runtime

Files:

- `.env.example`
- `backend/app/core/config.py`
- `backend/app/main.py`
- `backend/app/services/predictor.py`

Changes:

- Replaced `USE_DUMMY_PREDICTOR` with explicit `MODE=demo|real`.
- Added `MAX_CONCURRENT_PREDICTIONS`.
- Demo startup no longer downloads the approximately 438 MB model archive.
- Real mode resolves `model_data/webapp_database` automatically unless paths are overridden.
- Required checkpoint, gene panel, 32 embedding files, and 32 expression matrices are checked explicitly.
- Tar extraction rejects path traversal, symlinks, hard links, unexpected roots, and unsupported members.
- CPU prediction runs through FastAPI's threadpool behind a bounded semaphore.
- Health now returns mode, model version, reference scope, and panel size.

Main-branch idea worth adopting first: conditional model download plus explicit health metadata. This is low-risk and fixes a real startup/configuration defect without requiring the redesigned UI.

### 4.2 HER2-specific request contract

Files:

- `backend/app/api/routes.py`
- `backend/app/models/schemas.py`
- `backend/app/services/qc.py`
- `backend/app/services/predictor.py`

`POST /api/predict` still accepts multipart `file`, plus:

- `her2_positive_breast_tissue`: boolean-like string
- `stain`: H&E designation
- `microns_per_pixel`: finite number in the accepted range

Real mode requires all three. Demo mode permits missing scope metadata and labels its result synthetic.

Input handling added:

- MIME allowlist plus real image decoding
- Empty/invalid image detection
- JPEG/PNG/TIFF format verification
- Maximum compressed upload size
- Maximum decoded dimension and pixel count
- Pillow decompression-bomb handling
- Too-small, blank, excessive-resampling, and excessive-tile errors
- Stable 400/413/415/422 responses
- Generic 500 response without internal exception text

### 4.3 Physical-scale tiling and coordinates

The original backend tiled from `(0, 0)` using raw 224-pixel squares without validating image scale.

The alternate design:

- Uses the model assumption `224 px ≈ 100 µm`.
- Resamples from submitted microns-per-pixel to the model target scale.
- Runs tissue masking on the resampled image.
- Returns each accepted tile's center and bounds mapped back to original-image pixels.
- Returns coordinate metadata describing units, origin, and semantics.
- Keeps compatibility `spots`, but adds canonical `prediction_tiles`.

Important limitation: this reduces scale mismatch but does not make arbitrary tiling identical to the model's original training process, where patches were centered on known ST locations.

### 4.4 QC and applicability

New service:

- `backend/app/services/qc.py`

Returned QC includes:

- source dimensions
- tissue fraction
- brightness
- contrast
- mean saturation
- focus proxy
- accepted/rejected tile counts
- warnings

Applicability records:

- declared reference scope
- submitted HER2-positive breast confirmation
- submitted H&E confirmation
- whether the request was marked within the declared scope

These are basic computational checks, not assay QC or tissue-identity verification.

### 4.5 Retrieval support

`MclSTExpPredictor._retrieve` still uses the upstream evaluation behavior:

1. normalize query/reference embeddings;
2. select top 200 by cosine similarity;
3. weight measured reference expression using inverse-squared L1 distance on unnormalized embeddings.

The branch adds per-tile diagnostics:

- maximum selected cosine similarity
- mean selected cosine similarity
- effective neighbor count
- aggregate neighbor-expression dispersion

No diagnostic is described as calibrated confidence.

### 4.6 Reproducible spatial analysis

New service:

- `backend/app/services/analysis.py`

Added outputs:

- all-gene mean and population variance
- symmetric coordinate-neighbor graph
- Moran's I
- deterministic empirical permutation p-values
- Benjamini-Hochberg q-values
- top-variance gene selection
- per-gene standardization
- PCA
- deterministic K-means
- canonical domain identifiers
- silhouette score when defined
- domain-vs-rest standardized effects
- Welch tests and corrected q-values
- positive ranked domain markers

Default analysis parameters:

- analysis version: `spatial-analysis-v1`
- random seed: `19`
- Moran permutations: `99`
- requested domains: `5`
- maximum variable genes: `100`
- PCA components: up to `10`
- K-means initializations: `20`
- maximum markers per domain: `25`

The analysis runs on predicted, spatially autocorrelated tiles. It is exploratory and does not create biological replication.

### 4.7 ROI comparison

Endpoint:

```text
POST /api/analysis/roi
```

Input:

- complete prediction tiles
- explicit group A tile IDs
- explicit group B tile IDs
- optional gene subset
- permutation count and seed

Output:

- group sizes and means
- mean difference
- standardized effect
- empirical permutation p-value
- BH q-value
- permutation method and warnings

It attempts within-spatial-block label permutation and explicitly reports when unrestricted permutation was required.

### 4.8 Pathway enrichment

New service and endpoint:

- `backend/app/services/annotation.py`
- `POST /api/analysis/pathways`

Behavior:

- Uses a versioned archived g:Profiler endpoint.
- Restricts queries to genes in the 785-gene real panel.
- Uses the complete panel as custom background.
- Defaults to GO BP/CC/MF and Reactome.
- Returns source, term ID/name, adjusted p-value, contributing genes, API version, timestamp, and warnings.
- Returns stable upstream error codes and uses strict timeouts.

Demo mode does not have the 785-gene background, so pathway requests intentionally fail as unavailable.

### 4.9 Exports

New service and endpoints:

- `backend/app/services/export.py`
- `POST /api/analysis/exports/bundle`
- `POST /api/analysis/exports/{artifact}`

Bundle contents:

- `expression.csv`
- `gene_summary.csv`
- `domain_summary.csv`
- `domain_markers.csv`
- `manifest.json`
- `prediction-response.json`
- `research-report.html`
- `roi.geojson`
- `prediction.h5ad`

The HTML report includes scope, applicability, QC, methods, warnings, gene/domain summaries, provenance, and explicit predicted-not-measured language.

The H5AD-compatible file includes the untransformed prediction matrix, tile metadata, original-image coordinates, domain assignments, a raw prediction layer, and provenance metadata.

### 4.10 Backend dependencies

Added runtime dependencies:

- `scipy==1.15.3`
- `scikit-learn==1.6.1`
- `h5py==3.12.1`
- `httpx>=0.27.0`

Added `backend/requirements-dev.txt` for pytest rather than installing pytest in production images.

## 5. Frontend changes

### 5.1 Authoritative frontend types and API

Files:

- `frontend/src/lib/types.ts`
- `frontend/src/lib/api.ts`

Changes:

- Added typed mirrors of the expanded Pydantic response.
- Production scientific types no longer come from `mockPrediction.ts`.
- Prediction sends required HER2/H&E/mpp metadata.
- Removed browser-generated K-means and rank tertiles from the active flow.
- Removed replacement of raw expression with min-max values.
- Added typed ROI, pathway, and export calls.
- Added structured `APIError` with HTTP status and backend detail.

### 5.2 Upload flow

File:

- `frontend/src/components/UploadModal.tsx`

Changes:

- Explains HER2-positive breast scope and research-use limitation.
- Requires explicit tissue and stain confirmations for real input.
- Requires microns-per-pixel.
- Retains TIFF/PNG/JPEG and 50 MB client checks.
- Renames demo input to `synthetic-canvas-demo.png`.
- Makes synthetic demo visibly demo-only instead of calling it `her2_B1`.

### 5.3 Workspace information architecture

Files:

- `frontend/src/components/GeneXApp.tsx`
- `frontend/src/components/ScientificPanels.tsx`
- `frontend/src/app/globals.css`

The original three fixed columns were replaced with:

- Overview
- Genes
- Domains
- ROI
- Compare
- Methods

Overview shows scope, applicability, QC, warnings, input metadata, and model metadata.

Genes shows raw backend mean/variance, rank, Moran's I, empirical p, and q. Selecting a row updates the viewer.

Domains shows backend domain tile counts and returned marker effects/q-values. It does not invent biological names.

ROI lets users select tile groups A/B and calls the ROI endpoint.

Compare can load a second exported `prediction-response.json`, verifies panel/reference/output compatibility, and compares gene means, QC, and domain fractions. It does not imply pixelwise registration.

Methods shows model, retrieval, coordinate, expression, and analysis parameters.

### 5.4 H&E-linked viewer

File:

- `frontend/src/components/SpatialPlot.tsx`

Changes:

- Preserves original image aspect ratio.
- Draws the H&E image as the base layer.
- Uses original-image tile centers/bounds for real output.
- Supports H&E-only, raw gene, backend domain, and retrieval-support layers.
- Includes image and overlay opacity controls.
- Uses visualization color scaling without replacing raw values.
- Shows a numeric raw-value legend.
- Hover displays raw expression, domain, original coordinates, and retrieval diagnostics.
- ROI selection outlines group A/B tiles.
- Demo-grid coordinates are visibly normalized and labeled synthetic.
- Demo ROI selection falls back from null `tile_index` to `spot_index`.

Not implemented: zoom/pan, polygon-lasso ROI, direct slide registration, or WSI pyramidal rendering.

### 5.5 Evidence reader

Files:

- `frontend/src/lib/agent.ts`
- `frontend/src/components/ChatPanel.tsx`

The old chatbot was replaced with a collapsible deterministic reader that can only summarize loaded response evidence:

- QC/applicability
- highest returned raw prediction tile for a named gene
- returned domain markers/effects/q-values
- retrieval and analysis methods
- warnings and limitations

Statements are labeled `Predicted`, `Calculated`, `Annotated`, or `Hypothesis`. There is no LLM, fake delay, GeneCards claim, generated report claim, or unsupported biological interpretation.

### 5.6 Real download behavior

File:

- `frontend/src/lib/export.ts`

Changes:

- Downloads the backend ZIP only after receiving a non-empty Blob.
- Exports the current viewer canvas to PNG.
- Builds ROI MultiPolygon geometry only from returned tile bounds.
- Reports ZIP and PNG failures separately.
- No success toast is shown before a file is actually generated.

### 5.7 Honest request progress

File:

- `frontend/src/components/ProgressOverlay.tsx`

Removed invented checkpoint/tiling/embedding/K-means/save progress. It now states only that a backend request is in progress because the synchronous API does not publish internal progress events.

### 5.8 Frontend dependencies and security

`frontend/package.json` changes:

- Next.js: `16.3.0` → exact `16.3.5`
- ESLint Next config: `16.3.0` → exact `16.3.5`
- Added exact `nanoid 3.3.19` to resolve the transitive production advisory
- Added Vitest/Testing Library/jsdom test tooling
- Added exact `js-yaml 4.3.2`
- Vitest pinned to `4.1.11`

Final `npm audit` result on this branch: zero known vulnerabilities.

## 6. History and Supabase changes

Files:

- `supabase/migrations/0002_research_runs.sql`
- `frontend/src/lib/history.ts`
- `frontend/src/components/HistoryPanel.tsx`

Migration `0002` is additive and leaves `0001` unchanged.

New `predictions` fields include:

- complete expanded response JSON
- response format/version
- predictor mode
- tile count
- reference scope
- applicability status
- analysis version
- provenance summary
- QC summary

RPC: `public.save_research_run(text, text, jsonb)`

Security behavior:

- `SECURITY INVOKER`
- empty function search path
- ownership derived only from `auth.uid()`
- no user-ID RPC parameter
- image path must begin with authenticated user ID
- image filename must match prediction UUID
- validates complete status, model consistency, response sections, non-empty tiles, applicability, and timestamp
- execute revoked from public/anon and granted to authenticated
- existing `0001` RLS still applies

Frontend behavior:

- Uploads the private image with `upsert: false`.
- Calls one RPC containing the complete response.
- Removes only the just-uploaded image if the database RPC fails.
- Does not write new rows to legacy child tables.
- Loads expanded JSON directly after runtime validation.
- Continues reading legacy child records but labels them incompatible with the expanded workspace.
- Separates prediction-complete feedback from history-save feedback.

Deployment requirement: apply `0001`, then `0002`, and create the private `he-images` bucket.

## 7. Tests added

### Backend

Test files:

- `backend/tests/test_analysis.py`
- `backend/tests/test_annotation.py`
- `backend/tests/test_artifacts.py`
- `backend/tests/test_export.py`
- `backend/tests/test_qc.py`
- `backend/tests/test_retrieval.py`
- `backend/tests/test_roi.py`
- `backend/tests/test_routes.py`
- `backend/tests/test_schema.py`
- `backend/tests/test_stage2_routes.py`

Coverage includes artifact safety, QC, retrieval weighting, schema parity, deterministic spatial statistics/domains, ROI errors/statistics, mocked pathway behavior, every export artifact, and API error mapping.

Final backend result:

```text
37 passed
```

A non-blocking Starlette TestClient deprecation warning remains in the local Anaconda environment.

### Frontend

Tooling:

- `frontend/vitest.config.ts`
- Vitest, Testing Library, jest-dom, and jsdom

Tests:

- prediction metadata/API errors
- export Blob/ROI behavior
- evidence-reader routing and limitations
- HER2/H&E/mpp upload gating
- collapsible evidence panel
- real/demo tile identifier fallback

Final frontend result:

```text
6 test files passed
11 tests passed
ESLint passed
Next.js production build passed
npm audit: 0 vulnerabilities
```

Vitest currently emits a non-blocking warning that its TypeScript config uses ESM syntax while the package is treated as CommonJS. Tests still pass; a later cleanup could rename the config to an ESM extension or mark the frontend package as a module after checking all tooling.

## 8. Exact changed-file inventory

### Modified existing files

```text
.env.example
README.md
backend/app/api/routes.py
backend/app/core/config.py
backend/app/main.py
backend/app/models/schemas.py
backend/app/services/predictor.py
backend/requirements.txt
frontend/README.md
frontend/package-lock.json
frontend/package.json
frontend/src/app/globals.css
frontend/src/components/ChatPanel.tsx
frontend/src/components/GeneXApp.tsx
frontend/src/components/HistoryPanel.tsx
frontend/src/components/ProgressOverlay.tsx
frontend/src/components/SpatialPlot.tsx
frontend/src/components/UploadModal.tsx
frontend/src/lib/agent.ts
frontend/src/lib/api.ts
frontend/src/lib/history.ts
```

### Added files

```text
AGENTS.md
ALTERNATE_DESIGN_HANDOFF.md
backend/app/services/analysis.py
backend/app/services/annotation.py
backend/app/services/export.py
backend/app/services/qc.py
backend/requirements-dev.txt
backend/tests/test_analysis.py
backend/tests/test_annotation.py
backend/tests/test_artifacts.py
backend/tests/test_export.py
backend/tests/test_qc.py
backend/tests/test_retrieval.py
backend/tests/test_roi.py
backend/tests/test_routes.py
backend/tests/test_schema.py
backend/tests/test_stage2_routes.py
frontend/src/components/ChatPanel.test.tsx
frontend/src/components/ScientificPanels.tsx
frontend/src/components/SpatialPlot.test.ts
frontend/src/components/UploadModal.test.tsx
frontend/src/lib/agent.test.ts
frontend/src/lib/api.test.ts
frontend/src/lib/export.test.ts
frontend/src/lib/export.ts
frontend/src/lib/types.ts
frontend/src/test/fixture.ts
frontend/vitest.config.ts
supabase/migrations/0002_research_runs.sql
```

No files were deleted.

## 9. Commit map

### Backend runtime, contract, and analysis

```text
dc7cabd feat(analysis): add reproducible spatial methods
1a882bd feat(config): make prediction mode and QC explicit
d7e342f feat(model): expose scoped prediction provenance
f116b3a feat(annotation): ground pathway enrichment evidence
ab1c6a5 feat(export): create portable research bundles
ab8d85c fix(startup): verify model artifacts safely
686a5b4 feat(api): expose validated research workflows
533eaca test(model): cover QC retrieval and contracts
```

### Frontend redesign

```text
355172b feat(frontend): adopt the scientific API contract
1df3ee4 feat(viewer): anchor predictions to H&E morphology
85efcca feat(workspace): prioritize evidence over presentation
```

### Reports, downloads, assistant, and provenance

```text
9b325f8 feat(report): export complete research records
d6da5ab feat(download): generate real research exports
f56573b feat(workspace): wire honest export and progress states
3606788 feat(assistant): restrict narrative to returned evidence
918e10b feat(provenance): version derived spatial analysis
```

### History

```text
9f4b952 feat(history): persist immutable expanded responses
66167ff feat(history): surface saved-run provenance
```

### Tests, documentation, and dependency hardening

```text
fd7adb7 test(frontend): add deterministic unit test tooling
4f86529 test(assistant): protect evidence-only routing
e6ea018 test(frontend): cover API metadata and downloads
38f1142 test(components): cover scoped input and evidence UI
a2f437e build(backend): separate test dependencies
4d7d4c0 docs: document scientific scope and verification
469aa2d fix(roi): keep demo tile selection usable
1306a25 fix(deps): patch frontend security advisories
```

All commits above contain two or three files.

## 10. Recommended adoption strategy for `main`

Do not start by copying the complete workspace. Adopt in dependency order.

### Phase A: truth and runtime safety

Recommended first:

1. Explicit `MODE=demo|real` configuration.
2. Conditional model archive download.
3. Exact artifact validation and safe extraction.
4. Stable health metadata.
5. Structured image validation and 4xx errors.
6. Remove fake Export/progress/GeneCards behavior even if no replacement is adopted yet.

Relevant commits:

```text
1a882bd
ab8d85c
d7e342f
686a5b4
```

Caution: `d7e342f` expects the expanded schemas and QC/analysis modules. If `main` has diverged, port the concepts/file hunks rather than cherry-picking it alone.

### Phase B: morphology-linked viewer

Recommended next:

1. Preserve original pixel coordinates and tile bounds in the API.
2. Put H&E under overlays.
3. Keep raw values separate from display color scaling.
4. Replace client K-means with backend-returned domains.
5. Replace rank tertiles with named statistics.

Relevant commits:

```text
355172b
1df3ee4
85efcca
469aa2d
```

The viewer depends on the expanded backend response. It is not a standalone cherry-pick.

### Phase C: scientific analysis

Adopt if the team wants the analysis scope and dependencies:

```text
dc7cabd
f116b3a
```

Before production adoption, review statistical choices with the project scientist, especially:

- fixed requested `k=5`
- 99 permutations
- coordinate-neighbor graph
- tile-level Welch tests
- spatial block construction
- interpretation of effects/q-values on predicted data

### Phase D: export and history

Exports:

```text
ab1c6a5
9b325f8
d6da5ab
```

History:

```text
9f4b952
66167ff
```

Apply `0002_research_runs.sql` before deploying the updated history client. The new history client is not compatible with a database that has only `0001`.

### Phase E: testing and dependency patches

Testing and security commits are broadly reusable:

```text
533eaca
fd7adb7
4f86529
e6ea018
38f1142
1306a25
```

If `main` has different package versions, reproduce the audit and choose patched versions at least seven days old instead of blindly copying the lockfile.

## 11. Ideas that can be adopted independently

Low-coupling ideas:

- terminology/disclaimers
- synthetic-demo labeling
- honest indeterminate progress
- disabling/removing fake Export
- replacing chatbot with an evidence-only reader or removing it
- image decoder/pixel limits
- explicit predictor type in health
- no raw exception leakage
- test commands and `AGENTS.md`
- patched dependency versions

Medium-coupling ideas:

- QC service and result cards
- retrieval-support fields
- all-gene summary
- backend-generated domains
- real export bundles

High-coupling ideas:

- complete expanded `PredictionResponse`
- H&E-linked viewer
- ROI selection/comparison
- JSON compare workflow
- atomic expanded-response history
- full workspace redesign

## 12. What should not be copied blindly

- Do not claim the basic HSV tissue mask is validated pathology segmentation.
- Do not present retrieval support as confidence.
- Do not present domains as cell types or pathology regions.
- Do not treat tile-level p-values as patient-level evidence.
- Do not enable arbitrary-tissue uploads with the current HER2 reference model.
- Do not assume a 224-pixel patch has the correct physical size without mpp metadata.
- Do not assume the real checkpoint has been validated by this branch's tests; model artifacts were unavailable locally.
- Do not deploy history changes before migration `0002`.
- Do not assume the archived pathway endpoint will always be available.
- Do not copy `package-lock.json` if `main` has materially changed dependencies; perform targeted installs and audit again.

## 13. Known incomplete or unverified areas

- Full real-model inference was not executed locally because checkpoint/reference artifacts were absent.
- The current arbitrary-grid inference remains an adaptation of spot-centered training.
- Supabase migration/RPC was statically reviewed but not applied against a configured project.
- Live pathway enrichment was mocked in tests rather than called during verification.
- WSI pyramids, SVS/NDPI, GPU jobs, durable async workers, cancellation, and streamed progress are not implemented.
- Viewer zoom/pan and polygon-lasso ROI are not implemented.
- Multi-run compare loads one exported `prediction-response.json` against the current run; history multi-select and spatial registration are not implemented.
- H5AD output was validated structurally with HDF5 tests, not round-tripped through every downstream ecosystem.
- The current synchronous full-response history payload may approach Supabase request limits on large runs.
- The unused legacy `mockPrediction.ts` still contains synthetic pathology-flavored labels; the active workspace does not import them, but they should not be reused as real annotations.

## 14. Verification commands

From repository root:

```bash
cd backend
python -m pytest -q

cd ../frontend
npm test
npm run lint
npm run build
npm audit
```

Run locally in separate terminals:

```bash
cd backend
uvicorn app.main:app --reload --port 8000
```

```bash
cd frontend
npm run dev
```

The frontend defaults to `http://localhost:8000`. A browser error such as `ERR_CONNECTION_REFUSED` for `/api/predict` means the frontend is running but the backend is not listening. The correct backend command must be run from `backend/`, because backend imports use `app.*`.

## 15. Suggested main-branch decision checklist

Before porting an item, decide:

- Keep the original three-column layout or adopt the tabbed workspace?
- Keep synchronous inference or introduce a real job API?
- Require mpp and HER2/H&E confirmation?
- Use fixed `k=5`, expose configurable k, or defer domains?
- Include spatial statistics in the product or only export the matrix?
- Keep pathway enrichment as an optional external service?
- Persist full response JSON or normalized tables/object storage?
- Keep a deterministic evidence reader or remove conversational UI entirely?
- Support demo mode in production deployments?
- Which outputs have been reviewed by a domain scientist?

The safest main-branch path is to adopt truthfulness, runtime safety, H&E overlay, and real exports first; then add advanced analysis only after scientific review.
