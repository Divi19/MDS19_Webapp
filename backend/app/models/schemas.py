from pydantic import BaseModel
from datetime import datetime


class SpotPrediction(BaseModel):
    spot_index: int
    x: float
    y: float
    expression: dict[str, float]


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


class HealthResponse(BaseModel):
    status: str
    model_loaded: bool
    predictor_type: str


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