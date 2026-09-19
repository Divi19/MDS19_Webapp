export interface TileBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface RetrievalSupport {
  max_selected_cosine_similarity: number;
  mean_selected_cosine_similarity: number;
  effective_neighbor_count: number;
  aggregate_neighbor_expression_dispersion: number;
}

export interface PredictionTile {
  spot_index: number;
  tile_index: number | null;
  x: number;
  y: number;
  bounds: TileBounds | null;
  expression: Record<string, number>;
  retrieval_support: RetrievalSupport | null;
}

export type SpotPrediction = PredictionTile;

export interface GeneRanking {
  gene_name: string;
  mean_expression: number;
  rank: number;
}

export interface GeneSummary {
  gene_name: string;
  mean_expression: number;
  variance_expression: number;
}

export interface AllGeneSummary {
  authoritative: boolean;
  statistics: Array<"mean" | "variance">;
  genes: GeneSummary[];
}

export interface ModelMetadata {
  mode: "real" | "demo";
  model_version: string;
  reference_scope: string;
  panel_size: number;
  output_type: "prediction_tiles";
  retrieval_support_label: "retrieval_support" | null;
  retrieval_neighbor_selection: string | null;
  retrieval_weighting: string | null;
}

export interface ImageMetadata {
  format: string;
  width_pixels: number;
  height_pixels: number;
  pixel_count: number;
  microns_per_pixel: number | null;
  target_microns_per_pixel: number | null;
  resampled_width_pixels: number;
  resampled_height_pixels: number;
}

export interface CoordinateMetadata {
  x_y_units: string;
  bounds_units: "original_image_pixels";
  origin: "top_left";
  x_y_semantics: string;
}

export interface QualityControl {
  image_width: number;
  image_height: number;
  tissue_fraction: number;
  brightness: number;
  contrast: number;
  mean_saturation: number;
  focus_proxy: number;
  accepted_tile_count: number;
  rejected_tile_count: number;
  warnings: string[];
}

export interface Applicability {
  reference_scope: string;
  her2_positive_breast_tissue_confirmed: boolean;
  he_stain_confirmed: boolean;
  within_reference_scope: boolean;
}

export interface SpatialGeneStatistic {
  gene_name: string;
  mean_expression: number;
  variance_expression: number;
  morans_i: number | null;
  empirical_p_value: number;
  q_value: number;
}

export interface SpatialStatistics {
  neighbor_method: string;
  neighbor_count: number;
  permutations: number;
  seed: number;
  p_value_method: string;
  multiple_testing_method: string;
  genes: SpatialGeneStatistic[];
}

export interface DomainAssignment {
  tile_index: number;
  domain_id: string;
  label: "predicted-expression domain";
}

export interface DomainMarker {
  gene_name: string;
  rank: number;
  effect_size: number;
  welch_p_value: number;
  q_value: number;
  domain_mean: number;
  rest_mean: number;
  domain_detection_fraction: number;
  rest_detection_fraction: number;
}

export interface DomainSummary {
  domain_id: string;
  label: "predicted-expression domain";
  tile_count: number;
  markers: DomainMarker[];
}

export interface TileEmbedding {
  tile_index: number;
  components: number[];
}

export interface EmbeddingResult {
  method: "PCA";
  components: number;
  explained_variance_ratio: number[];
  tiles: TileEmbedding[];
}

export interface AnalysisMethod {
  result_type: "predicted-expression domains";
  variable_gene_selection: string;
  variable_gene_limit: number;
  variable_genes: string[];
  standardization: string;
  pca_solver: string;
  kmeans_requested_k: number;
  kmeans_fitted_k: number;
  kmeans_seed: number;
  kmeans_n_init: number;
  kmeans_algorithm: string;
  marker_effect_size: string;
  marker_test: string;
  silhouette: number | null;
}

export interface PredictionResponse {
  prediction_id: string;
  status: string;
  model_version: string;
  created_at: string;
  spots: SpotPrediction[];
  top_genes: GeneRanking[];
  prediction_tiles: PredictionTile[];
  model_metadata: ModelMetadata;
  image_metadata: ImageMetadata;
  coordinate_metadata: CoordinateMetadata;
  qc: QualityControl;
  applicability: Applicability;
  warnings: string[];
  all_gene_summary: AllGeneSummary;
  spatial_statistics: SpatialStatistics | null;
  domain_assignments: DomainAssignment[];
  domain_summaries: DomainSummary[];
  embeddings: EmbeddingResult | null;
  analysis_method: AnalysisMethod | null;
  analysis_warnings: string[];
}

export interface ROIAnalysisRequest {
  prediction_tiles: PredictionTile[];
  group_a_tile_indices: number[];
  group_b_tile_indices: number[];
  genes?: string[] | null;
  permutations?: number;
  seed?: number;
}

export interface ROIGeneComparison {
  gene_name: string;
  group_a_mean: number;
  group_b_mean: number;
  mean_difference: number;
  effect_size: number | null;
  permutation_p_value: number;
  q_value: number;
}

export interface ROIAnalysisResponse {
  label: "exploratory comparison of predicted spatially autocorrelated tiles";
  group_a_size: number;
  group_b_size: number;
  permutation_method: string;
  permutations: number;
  seed: number;
  genes: ROIGeneComparison[];
  warnings: string[];
}

export interface PathwayRequest {
  genes: string[];
  sources?: string[];
}

export interface PathwayTerm {
  source: string;
  term_id: string;
  term_name: string;
  adjusted_p_value: number;
  contributing_genes: string[];
}

export interface PathwayResponse {
  api_version: string;
  query: string[];
  background: string[];
  timestamp: string;
  terms: PathwayTerm[];
  warnings: string[];
}

export interface ExportROIGeometry {
  roi_id: string;
  tile_indices: number[];
  geometry: {
    type: "Polygon" | "MultiPolygon";
    coordinates: number[][][] | number[][][][];
  };
  properties: Record<string, unknown>;
}

export interface ExportRequest {
  prediction: PredictionResponse;
  roi_geometries: ExportROIGeometry[];
}

export interface HealthResponse {
  status: string;
  model_loaded: boolean;
  predictor_type: string;
  mode: "real" | "demo";
  model_version: string;
  reference_scope: string;
  panel_size: number;
}
