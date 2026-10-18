from pydantic import BaseModel
from datetime import datetime

from app.services.david_client import DEFAULT_CATEGORIES


class SpotPrediction(BaseModel):
    spot_index: int
    x: float
    y: float
    expression: dict[str, float]
    # Tissue-type classifier (tissue-v1). Null when the classifier is off,
    # failed, or the prediction predates it.
    tissue_class: str | None = None
    tissue_confidence: float | None = None
    tissue_probs: dict[str, float] | None = None


class TissueClassSummary(BaseModel):
    count: int
    fraction: float


class GeneRanking(BaseModel):
    gene_name: str
    mean_expression: float
    rank: int


class PredictionResponse(BaseModel):
    prediction_id: str
    status: str
    model_version: str
    created_at: datetime
    spots: list[SpotPrediction]
    top_genes: list[GeneRanking]
    tissue_model_version: str | None = None
    tissue_summary: dict[str, TissueClassSummary] | None = None
    # How spot grid indices map to original-image pixels: tile (x, y) covers
    # [x*stride_px, x*stride_px + tile_px). Null when the predictor does not
    # report it (the frontend then falls back to 224/224).
    tile_px: int | None = None
    stride_px: int | None = None
    # Multi-cancer serving. Null from predictors without a tissue router
    # (dummy, local MclSTExp, Modal with MULTICANCER off).
    # tissue: the router's verdict for the whole slide —
    #   {code, label, prob, supported, reason, limited_support, overridden,
    #    router_code?, probs?}. `code` is the router class (e.g. "COAD").
    tissue: dict | None = None
    # Units of every spot's `expression` values; differs per cancer model.
    expression_units: str | None = None
    # True for cancers with few training slides (PAAD, LYMPH_IDC, READ, BLCA).
    limited_support: bool | None = None


class HealthResponse(BaseModel):
    status: str
    model_loaded: bool
    predictor_type: str
    tissue_model_version: str | None = None


class PathwayRequest(BaseModel):
    genes: list[str]
    category: str = DEFAULT_CATEGORIES


class PathwayResult(BaseModel):
    term: str
    category: str
    pvalue: float
    benjamini: float
    fold_enrichment: float
    list_hits: int
    list_total: int
    genes: list[str]
    # Database ID (R-HSA-… / GO:…) when the source gives one; "" otherwise
    # (KEGG terms from Enrichr carry a name only). Used to look up a description.
    term_id: str = ""


class PathwayDescription(BaseModel):
    # None when the source has no text we can fetch (KEGG: link-out only).
    description: str | None = None
    url: str
