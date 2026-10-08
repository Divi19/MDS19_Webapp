import { describe, expect, it } from "vitest";
import { toPrediction } from "@/lib/api";
import {
  clusterTissueLabels, clusterTissueTable, comparableTypes, geneByTissue, geneHomeTissue, genesBetweenClusters,
  genesHigherIn, typeClusterGroups,
  isUncertain, predictionTissueFromApi, spotTissueFromApi, TISSUE_CLASSES,
} from "@/lib/tissue";
import { clusteredLargePrediction, LARGE_TISSUE_RESPONSE, OLD_RESPONSE, TISSUE_RESPONSE } from "@/test/fixtures";

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

  it("only compares types with enough tiles of their own and enough other tiles", () => {
    expect(comparableTypes(toPrediction(LARGE_TISSUE_RESPONSE))).toEqual(["Cancer", "Connective tissue"]);
    expect(comparableTypes(pred)).toEqual([]);
    expect(genesHigherIn(pred, "Cancer")).toEqual([]);
    expect(comparableTypes(toPrediction(OLD_RESPONSE))).toEqual([]);
  });

  it("lists genes clearly higher in a type, largest difference first", () => {
    const top = genesHigherIn(toPrediction(LARGE_TISSUE_RESPONSE), "Cancer");
    expect(top.map((g) => g.gene)).toEqual(["ERBB2"]);
    expect(top[0].typeMean).toBeCloseTo(2.1);
    expect(top[0].diff).toBeGreaterThan(0.9);
  });

  it("ignores a blanket lift of every gene in one tissue type", () => {
    // Dense tumour tissue gets higher predictions for almost every gene. Lift
    // every gene by 0.5 in Cancer tiles: only ERBB2 should still count as
    // higher in Cancer, not the flat background genes or CD74.
    const pred = toPrediction(LARGE_TISSUE_RESPONSE);
    const lifted = {
      ...pred,
      spots: pred.spots.map((s) =>
        s.tissue?.cls === "Cancer"
          ? { ...s, raw: Object.fromEntries(Object.entries(s.raw!).map(([g, v]) => [g, v + 0.5])) }
          : s,
      ),
    };
    expect(genesHigherIn(lifted, "Cancer").map((g) => g.gene)).toEqual(["ERBB2"]);
  });

  it("leaves out differences smaller than the tile-to-tile spread", () => {
    // LTF is 0.05 higher in Connective, but its tiles vary by about 0.14.
    expect(genesHigherIn(toPrediction(LARGE_TISSUE_RESPONSE), "Connective tissue")).toEqual([]);
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

const clustered = clusteredLargePrediction;

describe("linking tissue types with clusters and genes", () => {
  it("names each cluster by its tissue makeup", () => {
    expect(clusterTissueLabels(clustered())).toEqual([
      { full: "Cancer (100%)", short: "Cancer" },
      { full: "Cancer + Connective", short: "Mixed" },
      // Adipose has only 3 tiles on the slide, so it cannot name a cluster.
      { full: "Connective (57%)", short: "Connective" },
      null,
      null,
    ]);
  });

  it("gives no cluster names without tissue data or without a type of 10+ tiles", () => {
    expect(clusterTissueLabels(toPrediction(OLD_RESPONSE)).every((l) => l === null)).toBe(true);
    // TISSUE_RESPONSE has 3 Cancer and 1 Adipose tile: nothing can name a cluster.
    expect(clusterTissueLabels(toPrediction(TISSUE_RESPONSE)).every((l) => l === null)).toBe(true);
  });

  it("finds the tissue type each gene is clearly highest in", () => {
    const home = geneHomeTissue(toPrediction(LARGE_TISSUE_RESPONSE));
    expect(home.get("ERBB2")).toMatchObject({ cls: "Cancer" });
    expect(home.get("ERBB2")!.typeMean).toBeCloseTo(2.1);
    // CD74 is flat and LTF only differs by less than its spread.
    expect(home.has("CD74")).toBe(false);
    expect(home.has("LTF")).toBe(false);
  });

  it("lists the clusters a tissue type falls into, with at least 10 tiles each", () => {
    expect(typeClusterGroups(clustered(), "Cancer")).toEqual([
      { cluster: 0, count: 10 },
      { cluster: 1, count: 10 },
    ]);
    // Connective: 8 tiles in cluster 1 and 4 in cluster 2, both under 10.
    expect(typeClusterGroups(clustered(), "Connective tissue")).toEqual([]);
  });

  it("finds genes that differ between two clusters within one tissue type", () => {
    const { higherInA, higherInB } = genesBetweenClusters(clustered(), "Cancer", 0, 1);
    expect(higherInA).toEqual([]);
    expect(higherInB.map((g) => g.gene)).toEqual(["LTF"]);
    expect(higherInB[0].diff).toBeCloseTo(1);
  });
});
