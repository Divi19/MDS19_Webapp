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

  const { error: predictionError } = await supabase.from("predictions").insert({
    id: response.prediction_id,
    user_id: userId,
    filename: file.name,
    image_path: imagePath,
    model_version: response.model_version,
    status: response.status,
    created_at: response.created_at,
  });
  if (predictionError) throw new Error(`Saving prediction failed: ${predictionError.message}`);

  const spotRows = response.spots.map((s) => ({
    prediction_id: response.prediction_id,
    spot_index: s.spot_index,
    x: s.x,
    y: s.y,
    expression: s.expression,
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
    const { error } = await supabase.from("prediction_spots").insert(spotRows.slice(i, i + BATCH));
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

/** Reassembles one saved prediction back into the exact shape /api/predict
 * returns, so the existing toPrediction() conversion — and every component
 * downstream of it — needs no history-specific branching. */
export async function getPredictionResponse(
  predictionId: string,
): Promise<{ response: PredictionResponse; imageUrl: string | null; filename: string | null }> {
  const [{ data: pred, error: predErr }, { data: spots, error: spotsErr }, { data: genes, error: genesErr }] =
    await Promise.all([
      supabase.from("predictions").select("*").eq("id", predictionId).single(),
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
      spots: spots ?? [],
      top_genes: genes ?? [],
    },
    imageUrl,
    filename: pred.filename ?? null,
  };
}
