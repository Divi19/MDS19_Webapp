import { describe, expect, it } from "vitest";
import { SHOW_GENE_TISSUE_TAGS } from "./features";
import type { PathwayResult, PathwayState } from "./pathways";
import {
  isManualPhases,
  tourBody,
  TUTORIAL_CHAPTERS,
  TUTORIAL_NO_RESULT_STEP,
  TUTORIAL_STEPS,
  buildTourSteps,
  pickTourPathwayCluster,
  tourTarget,
} from "./tutorial";

const words = (text: string) => text.trim().split(/\s+/).length;

describe("tour content", () => {
  it("has unique ids and chapters that exist", () => {
    const ids = TUTORIAL_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const step of TUTORIAL_STEPS) {
      expect(step.chapter).toBeGreaterThanOrEqual(1);
      expect(step.chapter).toBeLessThanOrEqual(TUTORIAL_CHAPTERS.length);
    }
    // Every chapter has a step, so no chapter heading is ever empty.
    for (let c = 1; c <= TUTORIAL_CHAPTERS.length; c++) {
      expect(TUTORIAL_STEPS.some((s) => s.chapter === c)).toBe(true);
    }
  });

  it("keeps each card to one short paragraph, in neutral wording", () => {
    for (const step of [...TUTORIAL_STEPS, TUTORIAL_NO_RESULT_STEP]) {
      expect(step.body).toHaveLength(1);
      // About 20 words; the gene details card runs a little over.
      expect(words(step.body[0])).toBeLessThanOrEqual(25);
      for (const text of step.phaseBodies ?? []) expect(words(text)).toBeLessThanOrEqual(25);
    }
    const all = JSON.stringify([...TUTORIAL_STEPS, TUTORIAL_NO_RESULT_STEP]).toLowerCase();
    expect(all).not.toContain("diagnos");
  });

  it("follows the agreed order", () => {
    expect(TUTORIAL_STEPS.map((s) => s.id)).toEqual([
      "gene-list",
      "gene-pathways",
      "gene-map",
      "clusters",
      "pathways",
      "tissue-expression",
      "gradcam",
      "header-actions",
      "finish",
    ]);
  });

  it("shows the tissue map and legend, then the expression panels, in the tissue step", () => {
    const step = TUTORIAL_STEPS.find((x) => x.id === "tissue-expression")!;
    expect(step.phases).toEqual(["tissue-map tissue-legend", "tissue-expression tissue-genes-higher"]);
    expect(step.target).toBe(step.phases![0]);
    expect(step.interaction).toBe("free");
  });

  it("makes the no-result card a single notice", () => {
    expect(TUTORIAL_NO_RESULT_STEP.notice).toBe(true);
    expect(TUTORIAL_NO_RESULT_STEP.target).toBeUndefined();
    expect(TUTORIAL_NO_RESULT_STEP.body).toEqual(["Run or open an analysis first, then restart the tutorial."]);
  });
});

describe("buildTourSteps", () => {
  const ids = (a: Parameters<typeof buildTourSteps>[0]) => buildTourSteps(a).map((s) => s.id);

  it("shows every step when the result supports them", () => {
    expect(ids({ tissue: true, gradcam: true, pathways: true })).toHaveLength(9);
  });

  it("drops the Tissue step without tissue data", () => {
    const out = ids({ tissue: false, gradcam: true, pathways: true });
    expect(out).not.toContain("tissue-expression");
    expect(out).toContain("gradcam");
    expect(out).toHaveLength(8);
  });

  it("has no tissue composition step, and Grad-CAM follows the tissue step directly", () => {
    const all = ids({ tissue: true, gradcam: true, pathways: true });
    expect(all).not.toContain("tissue-composition");
    expect(all.slice(all.indexOf("pathways"))).toEqual(["pathways", "tissue-expression", "gradcam", "header-actions", "finish"]);
  });

  it("keeps the gene list's Cancer toggle moment only with tissue data and the tags switched on", () => {
    const withTissue = buildTourSteps({ tissue: true, gradcam: true, pathways: true })[0];
    if (SHOW_GENE_TISSUE_TAGS) {
      expect(withTissue.phases).toEqual(["gene-list", "cancer-filter gene-list"]);
      expect(withTissue.body[0]).toMatch(/Cancer toggle/);
    } else {
      expect(withTissue.phases).toBeUndefined();
      expect(withTissue.body[0]).not.toMatch(/toggle/i);
    }
    const without = buildTourSteps({ tissue: false, gradcam: true, pathways: true })[0];
    expect(without.id).toBe("gene-list");
    expect(without.phases).toBeUndefined();
    expect(without.body[0]).not.toMatch(/toggle/i);
  });

  it("drops Grad-CAM and pathways when unavailable", () => {
    const out = ids({ tissue: true, gradcam: false, pathways: false });
    expect(out).not.toContain("gradcam");
    expect(out).not.toContain("pathways");
    expect(out[0]).toBe("gene-list");
    expect(out[out.length - 1]).toBe("finish");
  });
});

describe("tourTarget", () => {
  const step = (id: string) => TUTORIAL_STEPS.find((s) => s.id === id)!;

  it("moves a two-moment step from its first target to its second", () => {
    expect(tourTarget(step("gene-map"), 0)).toBe("gene-first");
    expect(tourTarget(step("gene-map"), 1)).toBe("plot-card");
    expect(tourTarget(step("pathways"), 0)).toBe("pathway-pills");
    expect(tourTarget(step("pathways"), 1)).toBe("enrichment-modal");
    expect(tourTarget(step("pathways"), 9)).toBe("enrichment-modal");
  });

  it("switches the gene list on the Cancer toggle after its first moment", () => {
    expect(tourTarget(step("gene-list"), 0)).toBe("gene-list");
    expect(tourTarget(step("gene-list"), 1)).toBe("cancer-filter gene-list");
    expect(step("gene-list").phaseMs).toBe(1500);
  });

  it("opens the gene details beside the list and lets the presenter interact", () => {
    const g = step("gene-pathways");
    expect(g.target).toBe("gene-list enrichment-modal");
    expect(g.interaction).toBe("free");
    expect(g.phases).toBeUndefined();
    expect(tourTarget(g, 0)).toBe("gene-list enrichment-modal");
  });

  it("uses the plain target for single-moment steps", () => {
    expect(tourTarget(step("header-actions"), 0)).toBe("header-actions");
    expect(tourTarget(step("finish"), 0)).toBeUndefined();
  });

  it("merges the clusters and analysis steps into one two-moment step", () => {
    expect(TUTORIAL_STEPS.some((x) => x.id === "cluster-analysis")).toBe(false);
    expect(tourTarget(step("clusters"), 0)).toBe("plot-card cluster-breakdown");
    expect(tourTarget(step("clusters"), 1)).toBe("cluster-analysis");
  });

  it("gives Grad-CAM a map-and-scale moment, then the tile detail", () => {
    expect(tourTarget(step("gradcam"), 0)).toBe("gradcam-map gradcam-scale");
    expect(tourTarget(step("gradcam"), 1)).toBe("gradcam-detail");
    expect(step("gradcam").interaction).toBe("free");
    expect(step("gradcam").body).toEqual(["Warmer means more influence. Click a tile for the cells behind it. It explains the model, not the biology."]);
  });

  it("lets the presenter move between the moments of the interactive steps", () => {
    for (const id of ["clusters", "tissue-expression", "gradcam"]) expect(isManualPhases(step(id))).toBe(true);
    // The timed steps keep moving on by themselves.
    for (const id of ["gene-list", "gene-map", "pathways"]) expect(isManualPhases(step(id))).toBe(false);
    expect(isManualPhases(step("finish"))).toBe(false);
  });

  it("uses a different card sentence per moment where the step has them", () => {
    const tissue = step("tissue-expression");
    expect(tourBody(tissue, 0)).toEqual(["Hover a tile to see the model's tissue probabilities. Click a type to pin it."]);
    expect(tourBody(tissue, 1)).toEqual(["Click a gene in the list to map it."]);
    expect(tourBody(step("gradcam"), 1)).toEqual(step("gradcam").body);
  });
});

describe("pickTourPathwayCluster", () => {
  const row = (genes: string[]): PathwayResult => ({
    term: "t",
    category: "KEGG_PATHWAY",
    pvalue: 0.01,
    benjamini: 0.02,
    fold_enrichment: 0,
    list_hits: genes.length,
    list_total: 5,
    genes,
    term_id: "",
  });
  const done = (...genes: string[][]): PathwayState => ({ status: "done", results: genes.map(row) });

  it("picks the cluster whose top term matches the most genes", () => {
    expect(
      pickTourPathwayCluster({ 0: done(["A"]), 1: done(["A", "B", "C"]), 2: done(["A", "B"]) }),
    ).toBe(1);
  });

  it("looks only at the top term", () => {
    expect(pickTourPathwayCluster({ 0: done(["A"], ["A", "B", "C", "D"]), 1: done(["A", "B"]) })).toBe(1);
  });

  it("falls back to the first cluster with pathways on a tie", () => {
    expect(pickTourPathwayCluster({ 2: done(["A"]), 3: done(["B"]) })).toBe(2);
    expect(pickTourPathwayCluster({ 0: { status: "loading" }, 1: done([]), 2: done(["A"]) })).toBe(2);
  });

  it("is null when no cluster has pathways", () => {
    expect(pickTourPathwayCluster({})).toBeNull();
    expect(
      pickTourPathwayCluster({ 0: { status: "loading" }, 1: { status: "error", message: "x" }, 2: done() }),
    ).toBeNull();
  });
});
