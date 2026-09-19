import asyncio
import math
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Body, UploadFile, File, Form, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from pydantic import ValidationError

from app.models.schemas import ExportRequest, HealthResponse, PathwayRequest, PathwayResponse, PredictionResponse, ROIAnalysisRequest, ROIAnalysisResponse
from app.services.analysis import ROIAnalysisError, analyze_roi
from app.services.annotation import PathwayInputError, PathwayUpstreamError, enrich_pathways
from app.services.export import ExportError, export_artifact, export_bundle, validate_content_length
from app.services.predictor import PredictionInputError
from app.services.qc import ImageValidationError, decode_image

router = APIRouter()

MAX_UPLOAD_BYTES = 50 * 1024 * 1024   # 50 MB
ALLOWED_TYPES = {"image/jpeg", "image/png", "image/tiff"}
FALLBACK_PREDICTION_SEMAPHORE = asyncio.BoundedSemaphore(1)


def _parse_sample_metadata(
    predictor_mode: str,
    her2_positive_breast_tissue: str | None,
    stain: str | None,
    microns_per_pixel: str | None,
) -> dict:
    confirmation = None
    if her2_positive_breast_tissue is not None:
        normalized_confirmation = her2_positive_breast_tissue.strip().lower()
        if normalized_confirmation in {"true", "1", "yes"}:
            confirmation = True
        elif normalized_confirmation in {"false", "0", "no"}:
            confirmation = False
        else:
            raise HTTPException(status_code=422, detail="HER2-positive breast tissue confirmation must be true or false")
    normalized_stain = None
    if stain is not None:
        normalized_stain_input = stain.strip().lower().replace(" ", "")
        if normalized_stain_input in {"h&e", "he", "hande", "hematoxylinandeosin"}:
            normalized_stain = "H&E"
        else:
            normalized_stain = stain.strip()
    parsed_mpp = None
    if microns_per_pixel is not None:
        try:
            parsed_mpp = float(microns_per_pixel)
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=422, detail="Microns-per-pixel must be a number") from exc
        if not math.isfinite(parsed_mpp) or not 0.05 <= parsed_mpp <= 10.0:
            raise HTTPException(status_code=422, detail="Microns-per-pixel must be between 0.05 and 10.0")
    if predictor_mode == "real":
        if confirmation is not True:
            raise HTTPException(status_code=422, detail="Real mode requires confirmation of HER2-positive breast tissue")
        if normalized_stain != "H&E":
            raise HTTPException(status_code=422, detail="Real mode requires an H&E-stained sample")
        if parsed_mpp is None:
            raise HTTPException(status_code=422, detail="Real mode requires microns-per-pixel")
    return {
        "her2_positive_breast_tissue": confirmation,
        "stain": normalized_stain,
        "microns_per_pixel": parsed_mpp,
    }


@router.get("/health", response_model=HealthResponse)
async def health(request: Request):
    predictor = request.app.state.predictor
    return HealthResponse(
        status="ok",
        model_loaded=predictor.is_loaded,
        predictor_type=type(predictor).__name__,
        mode=predictor.mode,
        model_version=predictor.model_version,
        reference_scope=predictor.reference_scope,
        panel_size=predictor.panel_size,
    )


@router.post("/predict", response_model=PredictionResponse)
async def predict(
    request: Request,
    file: UploadFile = File(...),
    her2_positive_breast_tissue: str | None = Form(default=None),
    stain: str | None = Form(default=None),
    microns_per_pixel: str | None = Form(default=None),
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
    metadata = _parse_sample_metadata(
        predictor.mode,
        her2_positive_breast_tissue,
        stain,
        microns_per_pixel,
    )
    try:
        decode_image(image_bytes)
    except ImageValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    semaphore = getattr(request.app.state, "prediction_semaphore", FALLBACK_PREDICTION_SEMAPHORE)
    try:
        async with semaphore:
            result = await run_in_threadpool(predictor.predict, image_bytes, metadata)
    except (PredictionInputError, ImageValidationError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Prediction could not be completed") from exc

    return PredictionResponse(
        prediction_id=str(uuid.uuid4()),
        status="complete",
        model_version=result["model_version"],
        created_at=datetime.now(timezone.utc),
        spots=result["spots"],
        top_genes=result["top_genes"],
        prediction_tiles=result["prediction_tiles"],
        model_metadata=result["model_metadata"],
        image_metadata=result["image_metadata"],
        coordinate_metadata=result["coordinate_metadata"],
        qc=result["qc"],
        applicability=result["applicability"],
        warnings=result["warnings"],
        all_gene_summary=result["all_gene_summary"],
        spatial_statistics=result["spatial_statistics"],
        domain_assignments=result["domain_assignments"],
        domain_summaries=result["domain_summaries"],
        embeddings=result["embeddings"],
        analysis_method=result["analysis_method"],
        analysis_warnings=result["analysis_warnings"],
    )


@router.post("/analysis/roi", response_model=ROIAnalysisResponse)
async def roi_analysis(payload: Any = Body(...)):
    try:
        request_model = ROIAnalysisRequest.model_validate(payload)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail="ROI_INVALID_PAYLOAD") from exc
    try:
        result = await run_in_threadpool(
            analyze_roi,
            [tile.model_dump() for tile in request_model.prediction_tiles],
            request_model.group_a_tile_indices,
            request_model.group_b_tile_indices,
            request_model.genes,
            request_model.permutations,
            request_model.seed,
        )
    except ROIAnalysisError as exc:
        raise HTTPException(status_code=422, detail=exc.code) from exc
    return ROIAnalysisResponse.model_validate(result)


@router.post("/analysis/pathways", response_model=PathwayResponse)
async def pathway_analysis(request: Request, payload: Any = Body(...)):
    try:
        request_model = PathwayRequest.model_validate(payload)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail="PATHWAY_INVALID_PAYLOAD") from exc
    predictor = request.app.state.predictor
    background = getattr(predictor, "genes", None)
    if not isinstance(background, list) or len(set(background)) != 785:
        raise HTTPException(status_code=503, detail="PATHWAY_BACKGROUND_UNAVAILABLE")
    client = getattr(request.app.state, "pathway_client", None)
    try:
        result = await run_in_threadpool(
            enrich_pathways,
            request_model.genes,
            background,
            request_model.sources,
            client,
        )
    except PathwayInputError as exc:
        status_code = 503 if exc.code == "PATHWAY_BACKGROUND_UNAVAILABLE" else 422
        raise HTTPException(status_code=status_code, detail=exc.code) from exc
    except PathwayUpstreamError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.code) from exc
    return PathwayResponse.model_validate(result)


def _parse_export_request(request: Request, payload: Any) -> ExportRequest:
    try:
        validate_content_length(request.headers.get("content-length"))
        return ExportRequest.model_validate(payload)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail="EXPORT_INVALID_PAYLOAD") from exc
    except ExportError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.code) from exc


@router.post("/analysis/exports/bundle")
async def download_export_bundle(request: Request, payload: Any = Body(...)):
    export_request = _parse_export_request(request, payload)
    try:
        content = await run_in_threadpool(export_bundle, export_request)
    except ExportError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.code) from exc
    return Response(
        content=content,
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="prediction-export.zip"'},
    )


@router.post("/analysis/exports/{artifact}")
async def download_export_artifact(artifact: str, request: Request, payload: Any = Body(...)):
    export_request = _parse_export_request(request, payload)
    try:
        content, media_type, filename = await run_in_threadpool(export_artifact, export_request, artifact)
    except ExportError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.code) from exc
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
