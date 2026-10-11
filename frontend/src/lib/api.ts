import { cancerFromApi, type ApiCancerTissue } from "@/lib/cancer";
import type { Prediction, Spot, TopGene } from "@/lib/mockPrediction";
import { predictionTissueFromApi, spotTissueFromApi } from "@/lib/tissue";
import { tilingFromApi } from "@/lib/tiling";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export interface SpotPrediction {
  spot_index: number;
  x: number;
  y: number;
  expression: Record<string, number>;
  // Tissue-type classifier (tissue-v1). Absent or null on predictions made
  // without it — older saved ones included.
  tissue_class?: string | null;
  tissue_confidence?: number | null;
  tissue_probs?: Record<string, number> | null;
}

export interface TissueClassSummary {
  count: number;
  fraction: number;
}

export interface GeneRanking {
  gene_name: string;
  mean_expression: number;
  rank: number;
}

export interface PredictionResponse {
  prediction_id: string;
  status: string;
  model_version: string;
  created_at: string;
  spots: SpotPrediction[];
  top_genes: GeneRanking[];
  tissue_model_version?: string | null;
  tissue_summary?: Record<string, TissueClassSummary> | null;
  // How spot grid indices map to original-image pixels (lib/tiling.ts).
  // Absent from older backends and saved runs; see tilingFromApi.
  tile_px?: number | null;
  stride_px?: number | null;
  // Multi-cancer serving (lib/cancer.ts). Absent from breast-only backends
  // and from runs reopened from History.
  tissue?: ApiCancerTissue | null;
  expression_units?: string | null;
  limited_support?: boolean | null;
}

export async function predict(file: File): Promise<PredictionResponse> {
  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch(`${API_URL}/api/predict`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Prediction failed (${res.status}): ${detail}`);
  }

  return res.json();
}

/** Grad-CAM overlay (PNG) for one tissue tile, keyed by its spot_index. */
export async function explainGradcam(
  file: File,
  spotIndex: number,
  gene?: string,
  signal?: AbortSignal,
  tissue?: string,
): Promise<Blob> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("spot_index", String(spotIndex));
  if (gene) formData.append("gene", gene);
  if (tissue) formData.append("tissue", tissue);

  const res = await fetch(`${API_URL}/api/predict/gradcam`, {
    method: "POST",
    body: formData,
    signal,
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Grad-CAM failed (${res.status}): ${detail}`);
  }

  return res.blob();
}

export interface GradcamBatchTile {
  spot_index: number;
  png_base64: string;
  // Raw pre-normalisation heatmap strength — the PNG's own colours are
  // already scaled to that one spot's own peak, so this is the only way
  // to tell a strong spot from a weak one across the whole slide.
  peak: number;
  // Raw, pre-normalisation heat grid (row-major, heat_size = [h, w]) and the
  // soft tissue fraction per cell. With these the panel draws every tile as
  // ONE continuous map; an older backend omits them and the panel falls back
  // to the per-tile PNG above.
  heat?: number[];
  mask?: number[];
  heat_size?: [number, number];
}

/** Real per-tile Grad-CAM for several tiles in one forward/backward pass —
 * one HTTP round trip covers the whole batch instead of one per tile.
 *
 * gene, if given, targets every tile in the batch against that gene's
 * defining reference spot (an independent target, not each tile's own
 * self-selected nearest neighbour) — a deletion-test sensitivity check
 * showed the self-referential fallback (omitting gene) is measurably
 * weaker, since a tile's own nearest neighbour starts close to its own
 * maximum similarity, where the gradient is small by construction.
 *
 * tissue is the prediction's router class (CancerTissue.code), so the
 * multi-cancer service explains the same model on the same grid as predict
 * — spot_index then means the same tile. Omitted for breast-only runs. */
export async function explainGradcamBatch(
  file: File,
  spotIndices: number[],
  gene?: string,
  signal?: AbortSignal,
  tissue?: string,
): Promise<GradcamBatchTile[]> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("spot_indices", spotIndices.join(","));
  if (gene) formData.append("gene", gene);
  if (tissue) formData.append("tissue", tissue);

  const res = await fetch(`${API_URL}/api/predict/gradcam/batch`, {
    method: "POST",
    body: formData,
    signal,
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Grad-CAM batch failed (${res.status}): ${detail}`);
  }

  const data: { tiles: GradcamBatchTile[] } = await res.json();
  return data.tiles;
}

export async function checkHealth() {
  const res = await fetch(`${API_URL}/api/health`);
  if (!res.ok) throw new Error("API unreachable");
  return res.json();
}

function normalise(values: number[]) {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo;
  return values.map((value) => (span ? (value - lo) / span : 0.5));
}

function squaredDistance(a: number[], b: number[]) {
  let total = 0;
  for (let i = 0; i < a.length; i++) {
    const delta = a[i] - b[i];
    total += delta * delta;
  }
  return total;
}

/** Deterministic client-side k-means for the five-cluster UI. */
function cluster(vectors: number[][], requestedK = 5) {
  if (!vectors.length) return [];
  const k = Math.min(requestedK, vectors.length);
  const centroids: number[][] = [];

  // Farthest-first seeds are deterministic and avoid random UI changes.
  let first = 0;
  let firstNorm = -1;
  for (let i = 0; i < vectors.length; i++) {
    const norm = squaredDistance(vectors[i], new Array(vectors[i].length).fill(0));
    if (norm > firstNorm) {
      firstNorm = norm;
      first = i;
    }
  }
  centroids.push(vectors[first].slice());

  while (centroids.length < k) {
    let farthest = 0;
    let farthestDistance = -1;
    for (let i = 0; i < vectors.length; i++) {
      const nearest = Math.min(...centroids.map((c) => squaredDistance(vectors[i], c)));
      if (nearest > farthestDistance) {
        farthestDistance = nearest;
        farthest = i;
      }
    }
    centroids.push(vectors[farthest].slice());
  }

  const assignments = new Array(vectors.length).fill(0);
  for (let iteration = 0; iteration < 30; iteration++) {
    let changed = false;
    for (let i = 0; i < vectors.length; i++) {
      let best = 0;
      let bestDistance = Infinity;
      for (let c = 0; c < k; c++) {
        const distance = squaredDistance(vectors[i], centroids[c]);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = c;
        }
      }
      if (assignments[i] !== best) changed = true;
      assignments[i] = best;
    }

    const sums = Array.from({ length: k }, () => new Array(vectors[0].length).fill(0));
    const counts = new Array(k).fill(0);
    for (let i = 0; i < vectors.length; i++) {
      counts[assignments[i]]++;
      for (let d = 0; d < vectors[i].length; d++) {
        sums[assignments[i]][d] += vectors[i][d];
      }
    }
    for (let c = 0; c < k; c++) {
      if (counts[c]) centroids[c] = sums[c].map((value) => value / counts[c]);
    }
    if (!changed && iteration > 0) break;
  }
  return assignments;
}

/** Convert the API contract into the shape consumed by the existing visualisation. */
export function toPrediction(response: PredictionResponse): Prediction {
  if (!response.spots.length) throw new Error("The model returned no tissue spots");

  const genes = Object.keys(response.spots[0].expression);
  const xValues = normalise(response.spots.map((spot) => spot.x));
  const yValues = normalise(response.spots.map((spot) => spot.y));
  const normalisedByGene: Record<string, number[]> = {};
  for (const gene of genes) {
    normalisedByGene[gene] = normalise(
      response.spots.map((spot) => spot.expression[gene] ?? 0),
    );
  }

  // Every gene actually found in the tissue, ranked by its own raw mean
  // expression across all spots — not just the backend's top-50 shortlist.
  // This is the full panel, not a slice of it; the UI paginates it rather
  // than truncating it.
  const rawMeans: Record<string, number> = {};
  for (const gene of genes) {
    const values = response.spots.map((spot) => spot.expression[gene] ?? 0);
    rawMeans[gene] = values.reduce((a, b) => a + b, 0) / (values.length || 1);
  }
  const rankedGenes = genes.slice().sort((a, b) => rawMeans[b] - rawMeans[a]);

  const featureGenes = rankedGenes.filter((gene) => normalisedByGene[gene]).slice(0, 30);
  const vectors = response.spots.map((_, index) =>
    featureGenes.map((gene) => normalisedByGene[gene][index]),
  );
  const assignments = cluster(vectors, 5);

  const spots: Spot[] = response.spots.map((spot, index) => ({
    x: xValues[index],
    y: yValues[index],
    gridX: spot.x,
    gridY: spot.y,
    cluster: assignments[index] ?? 0,
    expr: Object.fromEntries(genes.map((gene) => [gene, normalisedByGene[gene][index]])),
    raw: spot.expression,
    tissue: spotTissueFromApi(spot),
  }));
  const tissue = predictionTissueFromApi(response);

  const counts = [0, 0, 0, 0, 0];
  for (const spot of spots) counts[spot.cluster]++;

  const n = rankedGenes.length || 1;
  const topGenes: TopGene[] = rankedGenes.map((name, index) => ({
    name,
    value: rawMeans[name],
    level: index / n < 1 / 3 ? "High" : index / n < 2 / 3 ? "Mid" : "Low",
  }));

  return {
    spots,
    genes,
    geneMeta: Object.fromEntries(
      genes.map((gene) => [gene, { label: gene, hx: 0, hy: 0, s: 0 }]),
    ),
    topGenes,
    clusters: counts.map((count, index) => ({
      index,
      name: `cluster ${index}`,
      count,
      fraction: spots.length ? count / spots.length : 0,
    })),
    counts,
    total: spots.length,
    tissue,
    tiling: tilingFromApi(response),
    cancer: cancerFromApi(response),
  };
}
