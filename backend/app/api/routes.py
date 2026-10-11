import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Request
from fastapi.responses import Response

from app.models.schemas import PredictionResponse, HealthResponse, PathwayRequest, PathwayResult
from app.services.david_client import PathwayLookupError
from app.services.errors import TissueNotSupportedError
from app.services.gradcam import tile_json
from app.services.wsi import is_wsi_filename, convert_wsi_to_image_bytes

router = APIRouter()

MAX_UPLOAD_BYTES = 50 * 1024 * 1024        # 50 MB -- regular jpeg/png/tiff uploads
MAX_WSI_UPLOAD_BYTES = 500 * 1024 * 1024   # 500 MB -- .svs/.ndpi/.mrxs-as-zip uploads
ALLOWED_TYPES = {"image/jpeg", "image/png", "image/tiff"}


async def _read_upload(file: UploadFile) -> bytes:
    if is_wsi_filename(file.filename):
        data = await file.read()
        if len(data) > MAX_WSI_UPLOAD_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"Whole-slide file too large (max "
                       f"{MAX_WSI_UPLOAD_BYTES // (1024 * 1024)}MB)")
        try:
            return convert_wsi_to_image_bytes(data, file.filename)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))

    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported type {file.content_type}. "
                   f"Allowed: {sorted(ALLOWED_TYPES)}",
        )
    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 50MB)")
    return data


@router.get("/health", response_model=HealthResponse)
async def health(request: Request):
    predictor = request.app.state.predictor
    return HealthResponse(
        status="ok",
        model_loaded=predictor.is_loaded,
        predictor_type=type(predictor).__name__,
        tissue_model_version=getattr(predictor, "tissue_model_version", None),
    )


@router.post("/predict", response_model=PredictionResponse)
async def predict(
    request: Request,
    file: UploadFile = File(...),
    # Multi-cancer router class (e.g. "COAD") chosen by the user. Bypasses
    # the tissue router and its "not supported" refusal.
    tissue: str | None = Form(None),
):
    tissue = (tissue or "").strip() or None
    predictor = request.app.state.predictor
    if tissue and not getattr(predictor, "supports_tissue_override", False):
        raise HTTPException(
            status_code=400,
            detail=f"Choosing the tissue type is not supported by this deployment "
                   f"({type(predictor).__name__})")

    image_bytes = await _read_upload(file)
    try:
        # Only pass tissue when given, so predictors without the parameter
        # keep their original predict(image_bytes) signature.
        result = (predictor.predict(image_bytes, tissue=tissue) if tissue
                  else predictor.predict(image_bytes))
    except TissueNotSupportedError as exc:
        raise HTTPException(status_code=422, detail={
            "code": "tissue_not_supported",
            "message": exc.message,
            "tissue": exc.tissue,
        })
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Prediction failed: {exc}")

    return PredictionResponse(
        prediction_id=str(uuid.uuid4()),
        status="complete",
        model_version=result["model_version"],
        created_at=datetime.now(timezone.utc),
        spots=result["spots"],
        top_genes=result["top_genes"],
        tissue_model_version=result.get("tissue_model_version"),
        tissue_summary=result.get("tissue_summary"),
        tile_px=result.get("tile_px"),
        stride_px=result.get("stride_px"),
        tissue=result.get("tissue"),
        expression_units=result.get("expression_units"),
        limited_support=result.get("limited_support"),
    )


@router.post("/predict/gradcam")
async def predict_gradcam(
    request: Request,
    file: UploadFile = File(...),
    spot_index: int = Form(...),
    gene: str | None = Form(None),
):
    image_bytes = await _read_upload(file)
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
    image_bytes = await _read_upload(file)
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


@router.post("/pathways", response_model=list[PathwayResult])
async def pathways(request: Request, body: PathwayRequest):
    client = request.app.state.david_client
    if client is None:
        raise HTTPException(
            status_code=501,
            detail="Pathway enrichment is not configured (DAVID_EMAIL unset)")
    if not body.genes:
        raise HTTPException(status_code=400, detail="genes must not be empty")

    try:
        return client.get_pathways(body.genes, category=body.category)
    except PathwayLookupError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Pathway lookup failed: {exc}")