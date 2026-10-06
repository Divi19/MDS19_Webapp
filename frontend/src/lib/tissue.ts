/**
 * Tissue-type classifier (tissue-v1) — display classes, colours and the
 * conversion from the API's nullable tissue fields.
 *
 * The backend already merges invasive + in situ into one "Cancer" class (the
 * model cannot tell them apart), so the frontend only ever sees these five.
 * Every tissue field is nullable: predictions made with the classifier off,
 * or saved before it existed, carry none and the tissue UI stays hidden.
 */

import type { Prediction, Spot } from "./mockPrediction";

export const TISSUE_CLASSES = [
  "Cancer",
  "Immune infiltrate",
  "Breast glands",
  "Connective tissue",
  "Adipose tissue",
] as const;

export type TissueClass = (typeof TISSUE_CLASSES)[number];

/** Okabe-Ito, colour-blind safe. */
export const TISSUE_COLORS: Record<TissueClass, string> = {
  Cancer: "#D55E00",
  "Immune infiltrate": "#0072B2",
  "Breast glands": "#CC79A7",
  "Connective tissue": "#009E73",
  "Adipose tissue": "#F0E442",
};

/** Compact legend labels (the full name is in the tooltip). */
export const TISSUE_SHORT_NAMES: Record<TissueClass, string> = {
  Cancer: "Cancer",
  "Immune infiltrate": "Immune",
  "Breast glands": "Glands",
  "Connective tissue": "Connective",
  "Adipose tissue": "Adipose",
};

/** Spots whose top class probability is below this are drawn faded with a
 * dashed outline and marked "uncertain" in the tooltip. */
export const LOW_CONFIDENCE = 0.5;

/** Tissue types with fewer tiles than this are greyed out in the per-type
 * statistics: a mean from a handful of tiles is not worth comparing. */
export const MIN_TILES = 10;

export type TissueProbs = Record<TissueClass, number>;

export interface SpotTissue {
  cls: TissueClass;
  confidence: number;
  probs: TissueProbs;
}

export type TissueSummary = Record<TissueClass, { count: number; fraction: number }>;

export interface PredictionTissue {
  version: string;
  summary: TissueSummary;
}

function isTissueClass(value: unknown): value is TissueClass {
  return typeof value === "string" && (TISSUE_CLASSES as readonly string[]).includes(value);
}

/** One spot's tissue fields from the API, or null if absent/malformed. */
export function spotTissueFromApi(spot: {
  tissue_class?: string | null;
  tissue_confidence?: number | null;
  tissue_probs?: Record<string, number> | null;
}): SpotTissue | null {
  const { tissue_class: cls, tissue_confidence: confidence, tissue_probs: probs } = spot;
  if (!isTissueClass(cls) || typeof confidence !== "number" || !probs) return null;
  if (!TISSUE_CLASSES.every((name) => typeof probs[name] === "number")) return null;
  const ordered = Object.fromEntries(TISSUE_CLASSES.map((name) => [name, probs[name]])) as TissueProbs;
  return { cls, confidence, probs: ordered };
}

/** Prediction-level tissue data, or null when the prediction has none —
 * the single switch for whether any tissue UI is shown. */
export function predictionTissueFromApi(response: {
  tissue_model_version?: string | null;
  tissue_summary?: Record<string, { count: number; fraction: number }> | null;
}): PredictionTissue | null {
  const { tissue_model_version: version, tissue_summary: summary } = response;
  if (!version || !summary) return null;
  if (!TISSUE_CLASSES.every((name) => summary[name] && typeof summary[name].count === "number")) return null;
  const ordered = Object.fromEntries(
    TISSUE_CLASSES.map((name) => [name, { count: summary[name].count, fraction: summary[name].fraction }]),
  ) as TissueSummary;
  return { version, summary: ordered };
}

export function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/* ---------- derived statistics (all computed in the browser) ---------- */

function rawValue(spot: Spot, gene: string): number {
  return spot.raw?.[gene] ?? spot.expr[gene] ?? 0;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/** Quantile of already-sorted values, linearly interpolated. */
function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export interface ClassGeneStat {
  cls: TissueClass;
  count: number;
  mean: number | null;
  /** Middle half of the tiles (25th to 75th percentile); null without tiles. */
  q1: number | null;
  q3: number | null;
  /** At least MIN_TILES tiles, so the numbers are worth comparing. */
  enough: boolean;
}

/** Mean and spread of raw predicted expression of `gene` within each tissue
 * class. */
export function geneByTissue(pred: Prediction, gene: string): ClassGeneStat[] {
  return TISSUE_CLASSES.map((cls) => {
    const values = pred.spots.filter((s) => s.tissue?.cls === cls).map((s) => rawValue(s, gene));
    const sorted = [...values].sort((a, b) => a - b);
    return {
      cls,
      count: values.length,
      mean: mean(values),
      q1: sorted.length ? quantile(sorted, 0.25) : null,
      q3: sorted.length ? quantile(sorted, 0.75) : null,
      enough: values.length >= MIN_TILES,
    };
  });
}

export interface EnrichedGene {
  gene: string;
  cancerMean: number;
  restMean: number;
  diff: number;
}

/** Genes with the largest mean predicted expression in Cancer tiles minus
 * all other classified tiles. Empty unless both groups have tiles. */
export function cancerEnrichedGenes(pred: Prediction, limit = 5): EnrichedGene[] {
  const cancer = pred.spots.filter((s) => s.tissue?.cls === "Cancer");
  const rest = pred.spots.filter((s) => s.tissue && s.tissue.cls !== "Cancer");
  if (!cancer.length || !rest.length) return [];
  return pred.genes
    .map((gene) => {
      const cancerMean = mean(cancer.map((s) => rawValue(s, gene)))!;
      const restMean = mean(rest.map((s) => rawValue(s, gene)))!;
      return { gene, cancerMean, restMean, diff: cancerMean - restMean };
    })
    .sort((a, b) => b.diff - a.diff)
    .slice(0, limit);
}

export function isUncertain(spot: Spot): boolean {
  return !!spot.tissue && spot.tissue.confidence < LOW_CONFIDENCE;
}

/** Tile counts per expression cluster (rows) and tissue class (columns). */
export function clusterTissueTable(pred: Prediction): number[][] {
  const rows = pred.counts.map(() => TISSUE_CLASSES.map(() => 0));
  for (const s of pred.spots) {
    if (!s.tissue || !rows[s.cluster]) continue;
    rows[s.cluster][TISSUE_CLASSES.indexOf(s.tissue.cls)]++;
  }
  return rows;
}
