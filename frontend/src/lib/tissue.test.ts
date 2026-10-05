import { describe, expect, it } from "vitest";
import { toPrediction } from "@/lib/api";
import { predictionTissueFromApi, spotTissueFromApi, TISSUE_CLASSES } from "@/lib/tissue";
import { OLD_RESPONSE, TISSUE_RESPONSE } from "@/test/fixtures";

describe("tissue fields from the API", () => {
  it("leaves an old prediction without any tissue data", () => {
    const pred = toPrediction(OLD_RESPONSE);
    expect(pred.tissue).toBeNull();
    expect(pred.spots.every((spot) => spot.tissue === null)).toBe(true);
    expect(pred.topGenes[0].name).toBe("ERBB2");
  });

  it("treats explicit nulls like absent fields", () => {
    const nulled = {
      ...OLD_RESPONSE,
      tissue_model_version: null,
      tissue_summary: null,
      spots: OLD_RESPONSE.spots.map((s) => ({ ...s, tissue_class: null, tissue_confidence: null, tissue_probs: null })),
    };
    expect(toPrediction(nulled).tissue).toBeNull();
  });

  it("carries tissue class, confidence, probabilities and summary through", () => {
    const pred = toPrediction(TISSUE_RESPONSE);
    expect(pred.tissue?.version).toBe("tissue-v1");
    expect(pred.tissue?.summary.Cancer).toEqual({ count: 3, fraction: 0.75 });
    expect(pred.spots[0].tissue?.cls).toBe("Cancer");
    expect(pred.spots[2].tissue?.confidence).toBeCloseTo(0.42);
    const probs = pred.spots[3].tissue!.probs;
    expect(Object.keys(probs)).toEqual([...TISSUE_CLASSES]);
    expect(Object.values(probs).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });

  it("does not change the expression conversion", () => {
    const before = toPrediction(OLD_RESPONSE);
    const after = toPrediction(TISSUE_RESPONSE);
    expect(after.spots.map((s) => s.expr)).toEqual(before.spots.map((s) => s.expr));
    expect(after.topGenes).toEqual(before.topGenes);
  });

  it("rejects unknown classes and incomplete probabilities", () => {
    expect(spotTissueFromApi({ tissue_class: "invasive cancer", tissue_confidence: 0.9, tissue_probs: {} })).toBeNull();
    expect(spotTissueFromApi({ tissue_class: "Cancer", tissue_confidence: 0.9, tissue_probs: { Cancer: 0.9 } })).toBeNull();
    expect(predictionTissueFromApi({ tissue_model_version: "tissue-v1", tissue_summary: {} })).toBeNull();
  });
});
