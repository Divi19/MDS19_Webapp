import type { PredictionResponse, PredictionTile } from "@/lib/types";
import { supabase } from "@/lib/supabaseClient";

const BUCKET = "he-images";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface HistoryEntry {
  id: string;
  createdAt: string;
  filename: string | null;
  modelVersion: string | null;
  imagePath: string | null;
  predictorMode: "real" | "demo" | null;
  tileCount: number | null;
  referenceScope: string | null;
  applicabilityStatus: "within_scope" | "outside_scope" | null;
  analysisVersion: string | null;
  legacyIncompatible: boolean;
}

interface LegacyStoredPredictionResponse {
  prediction_id: string;
  status: string;
  model_version: string;
  created_at: string;
  spots: Array<{
    spot_index: number;
    x: number;
    y: number;
    expression: Record<string, number>;
  }>;
  top_genes: Array<{
    gene_name: string;
    mean_expression: number;
    rank: number;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isExpression(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every(isFiniteNumber);
}

function isPredictionTile(value: unknown): value is PredictionTile {
  if (!isRecord(value)) return false;
  if (!Number.isInteger(value.spot_index) || (value.tile_index !== null && !Number.isInteger(value.tile_index))) return false;
  if (!isFiniteNumber(value.x) || !isFiniteNumber(value.y) || !isExpression(value.expression)) return false;
  if (value.bounds !== null) {
    if (!isRecord(value.bounds)) return false;
    if (![value.bounds.left, value.bounds.top, value.bounds.right, value.bounds.bottom].every(isFiniteNumber)) return false;
  }
  if (value.retrieval_support !== null) {
    if (!isRecord(value.retrieval_support)) return false;
    if (![value.retrieval_support.max_selected_cosine_similarity, value.retrieval_support.mean_selected_cosine_similarity, value.retrieval_support.effective_neighbor_count, value.retrieval_support.aggregate_neighbor_expression_dispersion].every(isFiniteNumber)) return false;
  }
  return true;
}

function isDomainAssignment(value: unknown): boolean {
  return isRecord(value) && Number.isInteger(value.tile_index) && typeof value.domain_id === "string" && value.label === "predicted-expression domain";
}

function isDomainSummary(value: unknown): boolean {
  return isRecord(value) && typeof value.domain_id === "string" && value.label === "predicted-expression domain" && Number.isInteger(value.tile_count) && Array.isArray(value.markers) && value.markers.every((marker) => isRecord(marker) && typeof marker.gene_name === "string" && [marker.effect_size, marker.q_value, marker.domain_mean, marker.rest_mean].every(isFiniteNumber));
}

function isExpandedPredictionResponse(value: unknown, predictionId: string): value is PredictionResponse {
  if (!isRecord(value)) return false;
  if (value.prediction_id !== predictionId || !UUID_PATTERN.test(predictionId)) return false;
  if (value.status !== "complete" || typeof value.model_version !== "string" || !value.model_version) return false;
  if (typeof value.created_at !== "string" || Number.isNaN(Date.parse(value.created_at))) return false;
  if (!Array.isArray(value.spots) || !value.spots.every(isPredictionTile)) return false;
  if (!Array.isArray(value.prediction_tiles) || value.prediction_tiles.length === 0 || !value.prediction_tiles.every(isPredictionTile)) return false;
  if (!Array.isArray(value.top_genes) || !value.top_genes.every((gene) => isRecord(gene) && typeof gene.gene_name === "string" && isFiniteNumber(gene.mean_expression) && Number.isInteger(gene.rank))) return false;
  if (!isRecord(value.model_metadata) || !["real", "demo"].includes(String(value.model_metadata.mode)) || value.model_metadata.model_version !== value.model_version || typeof value.model_metadata.reference_scope !== "string") return false;
  if (!isRecord(value.image_metadata) || typeof value.image_metadata.format !== "string" || ![value.image_metadata.width_pixels, value.image_metadata.height_pixels, value.image_metadata.pixel_count, value.image_metadata.resampled_width_pixels, value.image_metadata.resampled_height_pixels].every(isFiniteNumber) || !isNullableFiniteNumber(value.image_metadata.microns_per_pixel) || !isNullableFiniteNumber(value.image_metadata.target_microns_per_pixel)) return false;
  if (!isRecord(value.coordinate_metadata) || typeof value.coordinate_metadata.x_y_units !== "string" || value.coordinate_metadata.origin !== "top_left") return false;
  if (!isRecord(value.qc) || ![value.qc.image_width, value.qc.image_height, value.qc.tissue_fraction, value.qc.brightness, value.qc.contrast, value.qc.mean_saturation, value.qc.focus_proxy, value.qc.accepted_tile_count, value.qc.rejected_tile_count].every(isFiniteNumber) || !isStringArray(value.qc.warnings)) return false;
  if (!isRecord(value.applicability) || typeof value.applicability.reference_scope !== "string" || typeof value.applicability.her2_positive_breast_tissue_confirmed !== "boolean" || typeof value.applicability.he_stain_confirmed !== "boolean" || typeof value.applicability.within_reference_scope !== "boolean") return false;
  if (!isStringArray(value.warnings) || !isStringArray(value.analysis_warnings)) return false;
  if (!isRecord(value.all_gene_summary) || typeof value.all_gene_summary.authoritative !== "boolean" || !isStringArray(value.all_gene_summary.statistics) || !Array.isArray(value.all_gene_summary.genes) || !value.all_gene_summary.genes.every((gene) => isRecord(gene) && typeof gene.gene_name === "string" && isFiniteNumber(gene.mean_expression) && isFiniteNumber(gene.variance_expression))) return false;
  if (!Array.isArray(value.domain_assignments) || !value.domain_assignments.every(isDomainAssignment)) return false;
  if (!Array.isArray(value.domain_summaries) || !value.domain_summaries.every(isDomainSummary)) return false;
  if (value.spatial_statistics !== null && (!isRecord(value.spatial_statistics) || !Array.isArray(value.spatial_statistics.genes))) return false;
  if (value.embeddings !== null && (!isRecord(value.embeddings) || !Array.isArray(value.embeddings.tiles))) return false;
  if (value.analysis_method !== null && (!isRecord(value.analysis_method) || !isStringArray(value.analysis_method.variable_genes))) return false;
  return true;
}

/** Uploads the original image and persists a completed prediction under the
 * signed-in user. Called after a successful /api/predict — the backend is
 * unaware this happens. */
export async function savePrediction(
  userId: string,
  file: File,
  response: PredictionResponse,
): Promise<void> {
  const ext = file.name.includes(".") ? file.name.split(".").pop() : "bin";
  const imagePath = `${userId}/${response.prediction_id}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(imagePath, file, { upsert: false, contentType: file.type || undefined });
  if (uploadError) throw new Error(`Image upload failed: ${uploadError.message}`);

  // Supabase caps request size, not row count, but batch defensively for
  // very large spot counts.
  const { error: predictionError } = await supabase.rpc("save_research_run", {
    p_filename: file.name,
    p_image_path: imagePath,
    p_response: response,
  });
  if (!predictionError) return;

  const { error: cleanupError } = await supabase.storage.from(BUCKET).remove([imagePath]);
  if (cleanupError) {
    throw new Error(`Saving prediction failed: ${predictionError.message}. Image cleanup failed: ${cleanupError.message}`);
  }
  throw new Error(`Saving prediction failed: ${predictionError.message}`);
}

/** This user's saved predictions, newest first, with a signed thumbnail URL
 * for each (the storage bucket is private). */
export async function listPredictions(userId: string): Promise<
  (HistoryEntry & { imageUrl: string | null })[]
> {
  const { data, error } = await supabase
    .from("predictions")
    .select("id, created_at, filename, model_version, image_path, response_format, predictor_mode, tile_count, reference_scope, applicability_status, analysis_version")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Loading history failed: ${error.message}`);

  const rows = data ?? [];
  const withUrls = await Promise.all(
    rows.map(async (row) => {
      let imageUrl: string | null = null;
      if (row.image_path) {
        const { data: signed } = await supabase.storage
          .from(BUCKET)
          .createSignedUrl(row.image_path, 60 * 60);
        imageUrl = signed?.signedUrl ?? null;
      }
      return {
        id: row.id,
        createdAt: row.created_at,
        filename: row.filename,
        modelVersion: row.model_version,
        imagePath: row.image_path,
        predictorMode: row.predictor_mode === "real" || row.predictor_mode === "demo" ? row.predictor_mode : null,
        tileCount: typeof row.tile_count === "number" ? row.tile_count : null,
        referenceScope: row.reference_scope,
        applicabilityStatus: row.applicability_status === "within_scope" || row.applicability_status === "outside_scope" ? row.applicability_status : null,
        analysisVersion: row.analysis_version,
        legacyIncompatible: row.response_format !== "expanded_v1",
        imageUrl,
      };
    }),
  );
  return withUrls;
}

/** Reassembles one saved prediction back into the exact shape /api/predict
 * returns, so the existing toPrediction() conversion — and every component
 * downstream of it — needs no history-specific branching. */
export async function getPredictionResponse(
  predictionId: string,
): Promise<{ response: PredictionResponse | LegacyStoredPredictionResponse; imageUrl: string | null; filename: string | null }> {
  const { data: pred, error: predErr } = await supabase
    .from("predictions")
    .select("id, created_at, filename, model_version, status, image_path, response_format, response_json")
    .eq("id", predictionId)
    .single();

  if (predErr) throw new Error(`Loading prediction failed: ${predErr.message}`);

  let imageUrl: string | null = null;
  if (pred.image_path) {
    const { data: signed } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(pred.image_path, 60 * 60);
    imageUrl = signed?.signedUrl ?? null;
  }

  if (pred.response_format === "expanded_v1") {
    if (!isExpandedPredictionResponse(pred.response_json, pred.id)) {
      throw new Error("This saved response is malformed or uses an unsupported expanded response version.");
    }
    return { response: pred.response_json, imageUrl, filename: pred.filename ?? null };
  }

  const [{ data: spots, error: spotsErr }, { data: genes, error: genesErr }] = await Promise.all([
    supabase
      .from("prediction_spots")
      .select("spot_index, x, y, expression")
      .eq("prediction_id", predictionId)
      .order("spot_index", { ascending: true }),
    supabase
      .from("prediction_genes")
      .select("gene_name, mean_expression, rank")
      .eq("prediction_id", predictionId)
      .order("rank", { ascending: true }),
  ]);

  if (spotsErr) throw new Error(`Loading spots failed: ${spotsErr.message}`);
  if (genesErr) throw new Error(`Loading gene ranking failed: ${genesErr.message}`);

  return {
    response: {
      prediction_id: pred.id,
      status: pred.status,
      model_version: pred.model_version,
      created_at: pred.created_at,
      spots: spots ?? [],
      top_genes: genes ?? [],
    },
    imageUrl,
    filename: pred.filename ?? null,
  };
}
