import type { PredictionResponse } from "@/lib/api";
import { supabase } from "@/lib/supabaseClient";

const BUCKET = "he-images";

export interface HistoryEntry {
  id: string;
  createdAt: string;
  filename: string | null;
  modelVersion: string | null;
  imagePath: string | null;
}

// Tissue columns come from supabase/migrations/0004_tissue_classifier.sql.
const PREDICTION_TISSUE_COLUMNS = ["tissue_model_version", "tissue_summary"] as const;
const SPOT_TISSUE_COLUMNS = ["tissue_class", "tissue_confidence", "tissue_probs"] as const;

/** PostgREST's "column not in schema" errors — what an insert with tissue
 * columns gets from a database that hasn't had migration 0004 applied. */
function isMissingColumnError(error: { code?: string } | null): boolean {
  return !!error && (error.code === "PGRST204" || error.code === "42703");
}

function withoutColumns<T extends Record<string, unknown>>(row: T, columns: readonly string[]) {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !columns.includes(key)));
}

/** Inserts rows; if the database predates the tissue columns, retries once
 * without them so the prediction itself is still saved (tissue isn't). */
async function insertWithTissueFallback(
  table: "predictions" | "prediction_spots",
  rows: Record<string, unknown>[],
  tissueColumns: readonly string[],
) {
  const { error } = await supabase.from(table).insert(rows);
  if (!isMissingColumnError(error)) return { error };
  console.warn(`${table}: tissue columns missing (apply migration 0004) — saving without them`);
  return supabase.from(table).insert(rows.map((row) => withoutColumns(row, tissueColumns)));
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
    .upload(imagePath, file, { upsert: true, contentType: file.type || undefined });
  if (uploadError) throw new Error(`Image upload failed: ${uploadError.message}`);

  // Tissue columns are only sent when the prediction has tissue data, so a
  // prediction without it saves exactly as it did before migration 0004.
  const hasTissue = !!response.tissue_model_version && !!response.tissue_summary;
  const { error: predictionError } = await insertWithTissueFallback(
    "predictions",
    [{
      id: response.prediction_id,
      user_id: userId,
      filename: file.name,
      image_path: imagePath,
      model_version: response.model_version,
      status: response.status,
      created_at: response.created_at,
      ...(hasTissue && {
        tissue_model_version: response.tissue_model_version,
        tissue_summary: response.tissue_summary,
      }),
    }],
    PREDICTION_TISSUE_COLUMNS,
  );
  if (predictionError) throw new Error(`Saving prediction failed: ${predictionError.message}`);

  const spotRows = response.spots.map((s) => ({
    prediction_id: response.prediction_id,
    spot_index: s.spot_index,
    x: s.x,
    y: s.y,
    expression: s.expression,
    ...(hasTissue && {
      tissue_class: s.tissue_class ?? null,
      tissue_confidence: s.tissue_confidence ?? null,
      tissue_probs: s.tissue_probs ?? null,
    }),
  }));
  const geneRows = response.top_genes.map((g) => ({
    prediction_id: response.prediction_id,
    gene_name: g.gene_name,
    mean_expression: g.mean_expression,
    rank: g.rank,
  }));

  // Supabase caps request size, not row count, but batch defensively for
  // very large spot counts.
  const BATCH = 500;
  for (let i = 0; i < spotRows.length; i += BATCH) {
    const { error } = await insertWithTissueFallback(
      "prediction_spots", spotRows.slice(i, i + BATCH), SPOT_TISSUE_COLUMNS);
    if (error) throw new Error(`Saving spots failed: ${error.message}`);
  }
  if (geneRows.length) {
    const { error } = await supabase.from("prediction_genes").insert(geneRows);
    if (error) throw new Error(`Saving gene ranking failed: ${error.message}`);
  }
}

/** This user's saved predictions, newest first, with a signed thumbnail URL
 * for each (the storage bucket is private). */
export async function listPredictions(userId: string): Promise<
  (HistoryEntry & { imageUrl: string | null })[]
> {
  const { data, error } = await supabase
    .from("predictions")
    .select("id, created_at, filename, model_version, image_path")
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
        imageUrl,
      };
    }),
  );
  return withUrls;
}

/** Deletes a saved prediction. RLS already restricts this to the owning
 * user's rows; child spot/gene rows cascade via the FK. The storage object
 * is removed best-effort — the database row being gone is what the user
 * actually sees, so a leftover file (never surfaced anywhere in the UI)
 * isn't worth failing the whole delete over. */
export async function deletePrediction(predictionId: string, imagePath: string | null): Promise<void> {
  const { error } = await supabase.from("predictions").delete().eq("id", predictionId);
  if (error) throw new Error(`Deleting prediction failed: ${error.message}`);

  if (imagePath) {
    try {
      await supabase.storage.from(BUCKET).remove([imagePath]);
    } catch {
      // best-effort, see above
    }
  }
}

const IMAGE_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  tif: "image/tiff",
  tiff: "image/tiff",
};

/** Retrieves the original uploaded image for a saved prediction as a File.
 * Grad-CAM re-tiles the exact uploaded bytes, so a history-loaded run needs
 * the original file rather than only its signed display URL. The MIME type
 * falls back to the file extension because stored TIFFs can come back
 * untyped, and the API rejects uploads outside its image allowlist. */
export async function downloadPredictionImage(imagePath: string, filename: string | null): Promise<File> {
  const { data, error } = await supabase.storage.from(BUCKET).download(imagePath);
  if (error || !data) throw new Error(`Retrieving the original image failed: ${error?.message ?? "no data"}`);
  const name = filename ?? imagePath.split("/").pop() ?? "section";
  const extension = (name.split(".").pop() ?? "").toLowerCase();
  const type = data.type.startsWith("image/") ? data.type : (IMAGE_TYPES[extension] ?? data.type);
  return new File([data], name, { type });
}

/** Reassembles one saved prediction back into the exact shape /api/predict
 * returns, so the existing toPrediction() conversion — and every component
 * downstream of it — needs no history-specific branching. */
export async function getPredictionResponse(
  predictionId: string,
): Promise<{
  response: PredictionResponse;
  imageUrl: string | null;
  imagePath: string | null;
  filename: string | null;
}> {
  const [{ data: pred, error: predErr }, { data: spots, error: spotsErr }, { data: genes, error: genesErr }] =
    await Promise.all([
      supabase.from("predictions").select("*").eq("id", predictionId).single(),
      supabase
        .from("prediction_spots")
        // "*" rather than a column list: works whether or not migration 0004
        // (the tissue columns) has been applied; absent columns read as null.
        .select("*")
        .eq("prediction_id", predictionId)
        .order("spot_index", { ascending: true }),
      supabase
        .from("prediction_genes")
        .select("gene_name, mean_expression, rank")
        .eq("prediction_id", predictionId)
        .order("rank", { ascending: true }),
    ]);

  if (predErr) throw new Error(`Loading prediction failed: ${predErr.message}`);
  if (spotsErr) throw new Error(`Loading spots failed: ${spotsErr.message}`);
  if (genesErr) throw new Error(`Loading gene ranking failed: ${genesErr.message}`);

  let imageUrl: string | null = null;
  if (pred.image_path) {
    const { data: signed } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(pred.image_path, 60 * 60);
    imageUrl = signed?.signedUrl ?? null;
  }

  return {
    response: {
      prediction_id: pred.id,
      status: pred.status,
      model_version: pred.model_version,
      created_at: pred.created_at,
      spots: (spots ?? []).map((s) => ({
        spot_index: s.spot_index,
        x: s.x,
        y: s.y,
        expression: s.expression,
        tissue_class: s.tissue_class ?? null,
        tissue_confidence: s.tissue_confidence ?? null,
        tissue_probs: s.tissue_probs ?? null,
      })),
      top_genes: genes ?? [],
      tissue_model_version: pred.tissue_model_version ?? null,
      tissue_summary: pred.tissue_summary ?? null,
    },
    imageUrl,
    imagePath: pred.image_path ?? null,
    filename: pred.filename ?? null,
  };
}
