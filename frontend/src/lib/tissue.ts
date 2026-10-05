/**
 * Tissue-type classifier (tissue-v1) — display classes, colours and the
 * conversion from the API's nullable tissue fields.
 *
 * The backend already merges invasive + in situ into one "Cancer" class (the
 * model cannot tell them apart), so the frontend only ever sees these five.
 * Every tissue field is nullable: predictions made with the classifier off,
 * or saved before it existed, carry none and the tissue UI stays hidden.
 */

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

/** Spots whose top class probability is below this are drawn faded with a
 * dashed outline, and called out in the legend. */
export const LOW_CONFIDENCE = 0.5;

export const TISSUE_DISCLAIMER =
  "Tissue type: research prototype, HER2+ breast cancer only, not for diagnosis. " +
  "On unseen patients, cancer vs non-cancer: 87% sensitivity, 82% specificity. " +
  "Does not distinguish in situ from invasive cancer.";

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
