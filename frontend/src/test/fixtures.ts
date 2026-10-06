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

/** A larger section for the per-type statistics: 20 Cancer and 12
 * Connective tiles (enough to compare) and 3 Adipose tiles (too few).
 *  - ERBB2 is clearly higher in Cancer (2.0-2.2 vs 1.0-1.2).
 *  - CD74 is the same everywhere.
 *  - LTF is slightly higher in Connective, but by less than its spread. */
export const LARGE_TISSUE_RESPONSE: PredictionResponse = (() => {
  const groups: [(typeof TISSUE_CLASSES)[number], number, (i: number) => Record<string, number>][] = [
    ["Cancer", 20, (i) => ({ ERBB2: 2.0 + 0.05 * (i % 5), CD74: 0.5 + 0.02 * (i % 5), LTF: 0.3 + 0.1 * (i % 5) })],
    ["Connective tissue", 12, (i) => ({ ERBB2: 1.0 + 0.05 * (i % 5), CD74: 0.5 + 0.02 * (i % 5), LTF: 0.35 + 0.1 * (i % 5) })],
    ["Adipose tissue", 3, () => ({ ERBB2: 0.5, CD74: 0.5, LTF: 0.5 })],
  ];
  const spots = groups.flatMap(([cls, n, expression]) =>
    Array.from({ length: n }, (_, i) => ({ cls, expression: expression(i) })),
  ).map(({ cls, expression }, index) => ({
    spot_index: index,
    x: index % 6,
    y: Math.floor(index / 6),
    expression,
    tissue_class: cls,
    tissue_confidence: 0.9,
    tissue_probs: probs(cls, 0.9),
  }));
  const counts = Object.fromEntries(TISSUE_CLASSES.map((name) => [name, spots.filter((s) => s.tissue_class === name).length]));
  return {
    ...OLD_RESPONSE,
    spots,
    top_genes: [
      { gene_name: "ERBB2", mean_expression: 1.6, rank: 1 },
      { gene_name: "LTF", mean_expression: 0.5, rank: 2 },
      { gene_name: "CD74", mean_expression: 0.5, rank: 3 },
    ],
    tissue_model_version: "tissue-v1",
    tissue_summary: Object.fromEntries(
      TISSUE_CLASSES.map((name) => [name, { count: counts[name], fraction: counts[name] / spots.length }]),
    ),
  };
})();
