import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Request
from fastapi.responses import Response

from app.models.schemas import PredictionResponse, HealthResponse
from app.services.gradcam import tile_json

router = APIRouter()

MAX_UPLOAD_BYTES = 50 * 1024 * 1024   # 50 MB
ALLOWED_TYPES = {"image/jpeg", "image/png", "image/tiff"}


@router.get("/health", response_model=HealthResponse)
async def health(request: Request):
    predictor = request.app.state.predictor
    return HealthResponse(
        status="ok",
        model_loaded=predictor.is_loaded,
        predictor_type=type(predictor).__name__,
    )


@router.post("/predict", response_model=PredictionResponse)
async def predict(request: Request, file: UploadFile = File(...)):
    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported type {file.content_type}. "
                   f"Allowed: {sorted(ALLOWED_TYPES)}",
        )

    image_bytes = await file.read()
    if len(image_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 50MB)")

    predictor = request.app.state.predictor
    try:
        result = predictor.predict(image_bytes)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Prediction failed: {exc}")

    return PredictionResponse(
        prediction_id=str(uuid.uuid4()),
        status="complete",
        model_version=result["model_version"],
        created_at=datetime.now(timezone.utc),
        spots=result["spots"],
        top_genes=result["top_genes"],
    )


@router.post("/predict/gradcam")
async def predict_gradcam(
    request: Request,
    file: UploadFile = File(...),
    spot_index: int = Form(...),
    gene: str | None = Form(None),
):
    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported type {file.content_type}. "
                   f"Allowed: {sorted(ALLOWED_TYPES)}",
        )

    image_bytes = await file.read()
    if len(image_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 50MB)")

    predictor = request.app.state.predictor
    try:
        png_bytes = predictor.explain(image_bytes, spot_index, gene)
    except NotImplementedError as exc:
        raise HTTPException(status_code=501, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Grad-CAM failed: {exc}")

    return Response(content=png_bytes, media_type="image/png")


@router.post("/predict/gradcam/batch")
async def predict_gradcam_batch(
    request: Request,
    file: UploadFile = File(...),
    spot_indices: str = Form(...),  # comma-separated ints, e.g. "0,1,2,3"
    gene: str | None = Form(None),
):
    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported type {file.content_type}. "
                   f"Allowed: {sorted(ALLOWED_TYPES)}",
        )

    image_bytes = await file.read()
    if len(image_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 50MB)")

    try:
        indices = [int(x) for x in spot_indices.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail="spot_indices must be comma-separated integers")
    if not indices:
        raise HTTPException(status_code=400, detail="spot_indices must not be empty")

    predictor = request.app.state.predictor
    try:
        results = predictor.explain_batch(image_bytes, indices, gene)
    except NotImplementedError as exc:
        raise HTTPException(status_code=501, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Grad-CAM batch failed: {exc}")

    return {"tiles": [tile_json(i, t) for i, t in zip(indices, results)]}