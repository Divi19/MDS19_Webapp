from pydantic import BaseModel
from datetime import datetime


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


class HealthResponse(BaseModel):
    status: str
    model_loaded: bool
    predictor_type: str
    tissue_model_version: str | None = None


class PathwayRequest(BaseModel):
    genes: list[str]
    category: str = "KEGG_PATHWAY"


class PathwayResult(BaseModel):
    term: str
    category: str
    pvalue: float
    benjamini: float
    fold_enrichment: float
    list_hits: int
    list_total: int
    genes: list[str]