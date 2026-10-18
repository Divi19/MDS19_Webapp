import asyncio
import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response

from app.models.schemas import (
    PredictionResponse, HealthResponse, PathwayRequest, PathwayResult, PathwayDescription)
from app.services.david_client import PathwayLookupError
from app.services.errors import TissueNotSupportedError
from app.services.gradcam import tile_json
from app.services.pathway_description import PathwayDescriber
from app.services.wsi import is_wsi_filename, convert_wsi_to_image_bytes

router = APIRouter()
_describer = PathwayDescriber()
logger = logging.getLogger(__name__)

# Hard ceiling for one pathway lookup, so the client gets a readable error
# instead of the platform proxy's bare 502 when DAVID is slow.
PATHWAY_TIMEOUT_SECONDS = 45.0

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
            return await run_in_threadpool(convert_wsi_to_image_bytes, data, file.filename)
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


def _clean_tissue(tissue: str | None) -> str | None:
    """Optional `tissue` form field: blank means not given."""
    return (tissue or "").strip() or None


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
    tissue = _clean_tissue(tissue)
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
        # Blocking inference/relay work: off the event loop so other requests
        # (health, pathways, a second predict) are not frozen behind it.
        result = await (run_in_threadpool(predictor.predict, image_bytes, tissue=tissue)
                        if tissue
                        else run_in_threadpool(predictor.predict, image_bytes))
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
    # The prediction's tissue.code (or the user's override): which cancer
    # model and grid to explain. Ignored by breast-only predictors.
    tissue: str | None = Form(None),
):
    image_bytes = await _read_upload(file)
    predictor = request.app.state.predictor
    try:
        png_bytes = await run_in_threadpool(
            predictor.explain, image_bytes, spot_index, gene, tissue=_clean_tissue(tissue))
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
    tissue: str | None = Form(None),  # see predict_gradcam
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
        results = await run_in_threadpool(
            predictor.explain_batch, image_bytes, indices, gene, tissue=_clean_tissue(tissue))
    except NotImplementedError as exc:
        raise HTTPException(status_code=501, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Grad-CAM batch failed: {exc}")

    return {"tiles": [tile_json(i, t) for i, t in zip(indices, results)]}


@router.post("/pathways", response_model=list[PathwayResult])
async def pathways(request: Request, body: PathwayRequest):
    client = request.app.state.pathway_client
    if client is None:
        raise HTTPException(
            status_code=501,
            detail="Pathway enrichment is not configured (PATHWAY_PROVIDER=david needs DAVID_EMAIL)")
    if not body.genes:
        raise HTTPException(status_code=400, detail="genes must not be empty")

    try:
        # Blocking network calls; keep them off the event loop.
        return await asyncio.wait_for(
            run_in_threadpool(client.get_pathways, body.genes, category=body.category),
            timeout=PATHWAY_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        logger.warning("Pathway lookup timed out after %ss", PATHWAY_TIMEOUT_SECONDS)
        raise HTTPException(
            status_code=504,
            detail=f"Pathway lookup timed out after {int(PATHWAY_TIMEOUT_SECONDS)}s "
                   f"(the enrichment service is slow right now). Try again shortly.")
    except PathwayLookupError as exc:
        logger.warning("Pathway lookup failed: %s", exc)
        raise HTTPException(status_code=502, detail=str(exc))
    except Exception as exc:
        logger.exception("Pathway lookup crashed")
        raise HTTPException(status_code=500, detail=f"Pathway lookup failed: {exc}")


@router.get("/pathways/describe", response_model=PathwayDescription)
async def describe_pathway(category: str, term_id: str = "", term: str = ""):
    try:
        return await run_in_threadpool(_describer.describe, category, term_id, term)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except PathwayLookupError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
