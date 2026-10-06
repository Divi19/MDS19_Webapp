import { describe, expect, it } from "vitest";
import { toPrediction } from "@/lib/api";
import {
  cancerEnrichedGenes, clusterTissueTable, geneByTissue,
  isUncertain, predictionTissueFromApi, spotTissueFromApi, TISSUE_CLASSES,
} from "@/lib/tissue";
import { LARGE_TISSUE_RESPONSE, OLD_RESPONSE, TISSUE_RESPONSE } from "@/test/fixtures";

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

describe("tissue statistics", () => {
  const pred = toPrediction(TISSUE_RESPONSE);

  it("averages raw (not normalised) expression per tissue class", () => {
    const stats = geneByTissue(pred, "ERBB2");
    expect(stats.map((s) => s.cls)).toEqual([...TISSUE_CLASSES]);
    expect(stats[0]).toMatchObject({ cls: "Cancer", count: 3, mean: 2 });
    expect(stats[4]).toMatchObject({ cls: "Adipose tissue", count: 1, mean: 1.5 });
    expect(stats[1]).toMatchObject({ cls: "Immune infiltrate", count: 0, mean: null, q1: null, q3: null });
  });

  it("gives the middle half of each type's tiles and flags types with too few tiles", () => {
    const stats = geneByTissue(toPrediction(LARGE_TISSUE_RESPONSE), "ERBB2");
    const cancer = stats.find((s) => s.cls === "Cancer")!;
    expect(cancer).toMatchObject({ count: 20, enough: true });
    expect(cancer.q1).toBeCloseTo(2.05);
    expect(cancer.q3).toBeCloseTo(2.15);
    expect(stats.find((s) => s.cls === "Connective tissue")!.enough).toBe(true);
    expect(stats.find((s) => s.cls === "Adipose tissue")).toMatchObject({ count: 3, enough: false });
    expect(stats.find((s) => s.cls === "Immune infiltrate")).toMatchObject({ count: 0, enough: false });
  });

  it("ranks genes by cancer-minus-rest mean expression", () => {
    const top = cancerEnrichedGenes(pred);
    expect(top[0].gene).toBe("ERBB2");
    expect(top[0].diff).toBeCloseTo(0.5);
    expect(top[1].gene).toBe("CD74");
    expect(cancerEnrichedGenes(toPrediction(OLD_RESPONSE))).toEqual([]);
  });

  it("marks tiles whose top class is below 50% as uncertain", () => {
    expect(pred.spots.map(isUncertain)).toEqual([false, false, true, false]);
  });

  it("cross-tabulates expression clusters against tissue classes", () => {
    const table = clusterTissueTable(pred);
    expect(table).toHaveLength(pred.counts.length);
    expect(table.reduce((sum, row) => sum + row[0], 0)).toBe(3);
    expect(table.flat().reduce((a, b) => a + b, 0)).toBe(4);
  });
});
