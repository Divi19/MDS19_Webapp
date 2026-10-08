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

/** Tissue types with enough tiles, and enough other tiles, to compare
 * against the rest of the section. */
export function comparableTypes(pred: Prediction): TissueClass[] {
  const classified = pred.spots.filter((s) => s.tissue).length;
  return TISSUE_CLASSES.filter((cls) => {
    const n = pred.spots.filter((s) => s.tissue?.cls === cls).length;
    return n >= MIN_TILES && classified - n >= MIN_TILES;
  });
}

export interface HigherGene {
  gene: string;
  typeMean: number;
  restMean: number;
  diff: number;
}

function sd(values: number[], m: number): number {
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length);
}

/** Genes whose mean raw predicted expression is higher in tiles `a` than in
 * tiles `b`, largest difference first. A gene is only kept when the
 * difference is at least the typical tile-to-tile spread (the pooled
 * standard deviation of the two groups), so noise is left out. */
function genesHigherInGroup(pred: Prediction, a: Spot[], b: Spot[], limit: number): HigherGene[] {
  if (!a.length || !b.length) return [];
  return pred.genes
    .map((gene) => {
      const va = a.map((s) => rawValue(s, gene));
      const vb = b.map((s) => rawValue(s, gene));
      const typeMean = mean(va)!;
      const restMean = mean(vb)!;
      const spread = Math.sqrt((sd(va, typeMean) ** 2 + sd(vb, restMean) ** 2) / 2);
      return { gene, typeMean, restMean, diff: typeMean - restMean, spread };
    })
    .filter((g) => g.diff > 0 && g.diff >= g.spread)
    .sort((x, y) => y.diff - x.diff)
    .slice(0, limit)
    .map(({ gene, typeMean, restMean, diff }) => ({ gene, typeMean, restMean, diff }));
}

/** Genes clearly higher in `cls` tiles than in all other classified tiles
 * (see genesHigherInGroup). Empty when `cls` is not one of
 * comparableTypes(). */
export function genesHigherIn(pred: Prediction, cls: TissueClass, limit = 10): HigherGene[] {
  if (!comparableTypes(pred).includes(cls)) return [];
  const inType = pred.spots.filter((s) => s.tissue?.cls === cls);
  const rest = pred.spots.filter((s) => s.tissue && s.tissue.cls !== cls);
  return genesHigherInGroup(pred, inType, rest, limit);
}

export interface GeneTissue extends HigherGene {
  cls: TissueClass;
}

/** For each gene, the tissue type it is clearly most raised in (the
 * comparable type with the largest passing difference in genesHigherIn), or
 * nothing when no type clearly stands out. Feeds the gene list's TISSUE
 * column. */
export function geneHomeTissue(pred: Prediction): Map<string, GeneTissue> {
  const best = new Map<string, GeneTissue>();
  for (const cls of comparableTypes(pred)) {
    for (const g of genesHigherIn(pred, cls, Infinity)) {
      const prev = best.get(g.gene);
      if (!prev || g.diff > prev.diff) best.set(g.gene, { ...g, cls });
    }
  }
  return best;
}

export interface ClusterTissueLabel {
  /** e.g. "Cancer (95%)" or "Cancer + Connective". */
  full: string;
  /** One word for small spaces: the type's short name, or "Mixed". */
  short: string;
}

/** Share of a cluster's tiles a type needs to name the cluster on its own,
 * and to be listed in a two-type name. */
const DOMINANT_SHARE = 0.6;
const PART_SHARE = 0.2;

/**
 * A tissue name for each expression cluster (Clusters tab), from the tissue
 * types of its tiles. Only types with at least MIN_TILES tiles on the whole
 * slide can name a cluster.
 *  - one type with >= 60% of the cluster's tiles: "Cancer (95%)";
 *  - otherwise the types with >= 20%: "Cancer + Connective" (top two, short
 *    name "Mixed"), or "Cancer (50%)" when only one reaches 20%.
 * Null (the plain "cluster N" stays) for an empty cluster, for one where no
 * nameable type reaches 20%, and for every cluster when the prediction has
 * no tissue data.
 */
export function clusterTissueLabels(pred: Prediction): (ClusterTissueLabel | null)[] {
  if (!pred.tissue) return pred.counts.map(() => null);
  const eligible = TISSUE_CLASSES.map((cls) => pred.tissue!.summary[cls].count >= MIN_TILES);
  const pct = (f: number) => `${Math.round(f * 100)}%`;
  return clusterTissueTable(pred).map((row) => {
    const total = row.reduce((x, y) => x + y, 0);
    if (!total) return null;
    const parts = TISSUE_CLASSES.map((cls, i) => ({ cls, share: row[i] / total }))
      .filter((p, i) => eligible[i] && p.share >= PART_SHARE)
      .sort((x, y) => y.share - x.share);
    if (parts.length && (parts[0].share >= DOMINANT_SHARE || parts.length === 1)) {
      const name = TISSUE_SHORT_NAMES[parts[0].cls];
      return { full: `${name} (${pct(parts[0].share)})`, short: name };
    }
    if (parts.length >= 2) {
      return {
        full: `${TISSUE_SHORT_NAMES[parts[0].cls]} + ${TISSUE_SHORT_NAMES[parts[1].cls]}`,
        short: "Mixed",
      };
    }
    return null;
  });
}

export interface TypeClusterGroup {
  cluster: number;
  count: number;
}

/** The expression clusters that a tissue type's tiles fall into, keeping
 * clusters with at least MIN_TILES of them, largest first. */
export function typeClusterGroups(pred: Prediction, cls: TissueClass): TypeClusterGroup[] {
  const counts = new Map<number, number>();
  for (const s of pred.spots) {
    if (s.tissue?.cls === cls) counts.set(s.cluster, (counts.get(s.cluster) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([cluster, count]) => ({ cluster, count }))
    .filter((g) => g.count >= MIN_TILES)
    .sort((x, y) => y.count - x.count || x.cluster - y.cluster);
}

/** Within one tissue type, genes clearly higher in the tiles of cluster `a`
 * than in those of cluster `b`, and the other way round (same spread rule
 * as genesHigherIn). */
export function genesBetweenClusters(
  pred: Prediction,
  cls: TissueClass,
  a: number,
  b: number,
  limit = 5,
): { higherInA: HigherGene[]; higherInB: HigherGene[] } {
  const tilesA = pred.spots.filter((s) => s.tissue?.cls === cls && s.cluster === a);
  const tilesB = pred.spots.filter((s) => s.tissue?.cls === cls && s.cluster === b);
  return {
    higherInA: genesHigherInGroup(pred, tilesA, tilesB, limit),
    higherInB: genesHigherInGroup(pred, tilesB, tilesA, limit),
  };
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
