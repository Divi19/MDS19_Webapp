import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, UploadFile, File, HTTPException, Request

from app.models.schemas import PredictionResponse, HealthResponse

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