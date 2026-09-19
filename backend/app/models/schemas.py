from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


class TileBounds(BaseModel):
    left: float
    top: float
    right: float
    bottom: float


class RetrievalSupport(BaseModel):
    max_selected_cosine_similarity: float
    mean_selected_cosine_similarity: float
    effective_neighbor_count: float
    aggregate_neighbor_expression_dispersion: float


class PredictionTile(BaseModel):
    spot_index: int
    tile_index: int | None = None
    x: float
    y: float
    bounds: TileBounds | None = None
    expression: dict[str, float]
    retrieval_support: RetrievalSupport | None = None


class SpotPrediction(PredictionTile):
    pass


class GeneRanking(BaseModel):
    gene_name: str
    mean_expression: float
    rank: int


class GeneSummary(BaseModel):
    gene_name: str
    mean_expression: float
    variance_expression: float


class AllGeneSummary(BaseModel):
    authoritative: bool
    statistics: list[Literal["mean", "variance"]]
    genes: list[GeneSummary]


class ModelMetadata(BaseModel):
    mode: Literal["real", "demo"]
    model_version: str
    reference_scope: str
    panel_size: int
    output_type: Literal["prediction_tiles"]
    retrieval_support_label: Literal["retrieval_support"] | None = None
    retrieval_neighbor_selection: str | None = None
    retrieval_weighting: str | None = None


class ImageMetadata(BaseModel):
    format: str
    width_pixels: int
    height_pixels: int
    pixel_count: int
    microns_per_pixel: float | None
    target_microns_per_pixel: float | None
    resampled_width_pixels: int
    resampled_height_pixels: int


class CoordinateMetadata(BaseModel):
    x_y_units: str
    bounds_units: Literal["original_image_pixels"]
    origin: Literal["top_left"]
    x_y_semantics: str


class QualityControl(BaseModel):
    image_width: int
    image_height: int
    tissue_fraction: float
    brightness: float
    contrast: float
    mean_saturation: float
    focus_proxy: float
    accepted_tile_count: int
    rejected_tile_count: int
    warnings: list[str]


class Applicability(BaseModel):
    reference_scope: str
    her2_positive_breast_tissue_confirmed: bool
    he_stain_confirmed: bool
    within_reference_scope: bool


class SpatialGeneStatistic(BaseModel):
    gene_name: str
    mean_expression: float
    variance_expression: float
    morans_i: float | None
    empirical_p_value: float
    q_value: float


class SpatialStatistics(BaseModel):
    neighbor_method: str
    neighbor_count: int
    permutations: int
    seed: int
    p_value_method: str
    multiple_testing_method: str
    genes: list[SpatialGeneStatistic]


class DomainAssignment(BaseModel):
    tile_index: int
    domain_id: str
    label: Literal["predicted-expression domain"]


class DomainMarker(BaseModel):
    gene_name: str
    rank: int
    effect_size: float
    welch_p_value: float
    q_value: float
    domain_mean: float
    rest_mean: float
    domain_detection_fraction: float
    rest_detection_fraction: float


class DomainSummary(BaseModel):
    domain_id: str
    label: Literal["predicted-expression domain"]
    tile_count: int
    markers: list[DomainMarker]


class TileEmbedding(BaseModel):
    tile_index: int
    components: list[float]


class EmbeddingResult(BaseModel):
    method: Literal["PCA"]
    components: int
    explained_variance_ratio: list[float]
    tiles: list[TileEmbedding]


class AnalysisMethod(BaseModel):
    analysis_version: Literal["spatial-analysis-v1"]
    result_type: Literal["predicted-expression domains"]
    variable_gene_selection: str
    variable_gene_limit: int
    variable_genes: list[str]
    standardization: str
    pca_solver: str
    kmeans_requested_k: int
    kmeans_fitted_k: int
    kmeans_seed: int
    kmeans_n_init: int
    kmeans_algorithm: str
    marker_effect_size: str
    marker_test: str
    silhouette: float | None


class PredictionResponse(BaseModel):
    prediction_id: str
    status: str
    model_version: str
    created_at: datetime
    spots: list[SpotPrediction]
    top_genes: list[GeneRanking]
    prediction_tiles: list[PredictionTile]
    model_metadata: ModelMetadata
    image_metadata: ImageMetadata
    coordinate_metadata: CoordinateMetadata
    qc: QualityControl
    applicability: Applicability
    warnings: list[str]
    all_gene_summary: AllGeneSummary
    spatial_statistics: SpatialStatistics | None = None
    domain_assignments: list[DomainAssignment] = Field(default_factory=list)
    domain_summaries: list[DomainSummary] = Field(default_factory=list)
    embeddings: EmbeddingResult | None = None
    analysis_method: AnalysisMethod | None = None
    analysis_warnings: list[str] = Field(default_factory=list)


class ROIAnalysisRequest(BaseModel):
    prediction_tiles: list[PredictionTile]
    group_a_tile_indices: list[int]
    group_b_tile_indices: list[int]
    genes: list[str] | None = None
    permutations: int = 99
    seed: int = 19


class ROIGeneComparison(BaseModel):
    gene_name: str
    group_a_mean: float
    group_b_mean: float
    mean_difference: float
    effect_size: float | None
    permutation_p_value: float
    q_value: float


class ROIAnalysisResponse(BaseModel):
    label: Literal["exploratory comparison of predicted spatially autocorrelated tiles"]
    group_a_size: int
    group_b_size: int
    permutation_method: str
    permutations: int
    seed: int
    genes: list[ROIGeneComparison]
    warnings: list[str]


class PathwayRequest(BaseModel):
    genes: list[str]
    sources: list[str] = Field(default_factory=lambda: ["GO:BP", "GO:CC", "GO:MF", "REAC"])


class PathwayTerm(BaseModel):
    source: str
    term_id: str
    term_name: str
    adjusted_p_value: float
    contributing_genes: list[str]


class PathwayResponse(BaseModel):
    api_version: str
    query: list[str]
    background: list[str]
    timestamp: datetime
    terms: list[PathwayTerm]
    warnings: list[str]


class ExportROIGeometry(BaseModel):
    roi_id: str
    tile_indices: list[int]
    geometry: dict[str, Any]
    properties: dict[str, Any] = Field(default_factory=dict)


class ExportRequest(BaseModel):
    prediction: PredictionResponse
    roi_geometries: list[ExportROIGeometry] = Field(default_factory=list)


class HealthResponse(BaseModel):
    status: str
    model_loaded: bool
    predictor_type: str
    mode: Literal["real", "demo"]
    model_version: str
    reference_scope: str
    panel_size: int
