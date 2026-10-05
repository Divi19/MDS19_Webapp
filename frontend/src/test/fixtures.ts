import type { PredictionResponse } from "@/lib/api";
import { TISSUE_CLASSES } from "@/lib/tissue";

/** A prediction exactly as the API returned it before the tissue classifier
 * existed — and as old history rows still reassemble. */
export const OLD_RESPONSE: PredictionResponse = {
  prediction_id: "00000000-0000-0000-0000-000000000001",
  status: "complete",
  model_version: "mclstexp-her2st-best_0+smooth0.6",
  created_at: "2026-09-29T12:00:00Z",
  spots: [
    { spot_index: 0, x: 0, y: 0, expression: { ERBB2: 1.0, CD74: 0.2 } },
    { spot_index: 1, x: 1, y: 0, expression: { ERBB2: 2.0, CD74: 0.4 } },
    { spot_index: 2, x: 0, y: 1, expression: { ERBB2: 3.0, CD74: 0.1 } },
    { spot_index: 3, x: 1, y: 1, expression: { ERBB2: 1.5, CD74: 0.9 } },
  ],
  top_genes: [
    { gene_name: "ERBB2", mean_expression: 1.875, rank: 1 },
    { gene_name: "CD74", mean_expression: 0.4, rank: 2 },
  ],
};

function probs(main: (typeof TISSUE_CLASSES)[number], p: number) {
  const rest = (1 - p) / (TISSUE_CLASSES.length - 1);
  return Object.fromEntries(TISSUE_CLASSES.map((name) => [name, name === main ? p : rest]));
}

/** The same prediction with tissue-v1 output: 3 Cancer spots (one of them
 * low confidence) and 1 Adipose spot. */
export const TISSUE_RESPONSE: PredictionResponse = {
  ...OLD_RESPONSE,
  spots: OLD_RESPONSE.spots.map((spot, index) => {
    const [cls, p] = index === 3 ? (["Adipose tissue", 0.8] as const)
      : index === 2 ? (["Cancer", 0.42] as const)
      : (["Cancer", 0.9] as const);
    return { ...spot, tissue_class: cls, tissue_confidence: p, tissue_probs: probs(cls, p) };
  }),
  tissue_model_version: "tissue-v1",
  tissue_summary: Object.fromEntries(
    TISSUE_CLASSES.map((name) => {
      const count = name === "Cancer" ? 3 : name === "Adipose tissue" ? 1 : 0;
      return [name, { count, fraction: count / 4 }];
    }),
  ),
};
