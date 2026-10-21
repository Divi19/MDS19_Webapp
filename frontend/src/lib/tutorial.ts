/**
 * Guided tutorial content: a short live-demo tour of a result that is already
 * on screen (the presenter runs or opens an analysis first, then presses
 * Take the Tutorial).
 *
 * Each step highlights the elements marked with a matching `data-tour`
 * attribute. Steps without a target render as a centred card. The workspace
 * (GeneXApp) owns the step state and prepares the page for each step —
 * switching views and tabs, opening the pathway table — so this file only
 * describes what is shown.
 */

import type { PathwayState } from "@/lib/pathways";
import { SHOW_GENE_TISSUE_TAGS } from "@/lib/features";

export type TutorialInteraction =
  /** The highlighted element is clickable, and clicking it advances the
   * tutorial. Next performs the same click on the user's behalf. */
  | "advance"
  /** The highlighted element is clickable, but clicking it does not advance
   * the tutorial (for example, expanding a row in the pathway table). */
  | "free";

export type TutorialPlacement = "top" | "bottom" | "left" | "right";

export interface TutorialStep {
  id: string;
  chapter: number;
  /** `data-tour` value(s) to highlight. Several values, separated by spaces,
   * are highlighted together: the spotlight covers all of them. */
  target?: string;
  /** For a step with two moments: the target of each moment, in order. The
   * workspace moves to the next one by itself after a short pause (and does
   * whatever that moment shows, e.g. opens a window). `target` is the first. */
  phases?: string[];
  /** How long the first moment lasts before the next one, in ms
   * (DEFAULT_PHASE_MS when omitted). 0 means the presenter moves between the
   * moments: Next goes to the second moment and then on, Back returns to the
   * first. Used where the presenter is talking or interacting. */
  phaseMs?: number;
  /** For a step with two moments: the card sentence for each moment, when it
   * differs from `body`. */
  phaseBodies?: string[];
  title: string;
  body: string[];
  interaction?: TutorialInteraction;
  /** Shown beneath the body on steps the user can act on directly. */
  actionHint?: string;
  /** Shown instead of the action hint when the target is not on the page. */
  missingTargetNote?: string;
  placement?: TutorialPlacement;
  /** A one-card notice rather than part of the tour: no chapter, progress
   * dots, count or Skip; a single Close button. */
  notice?: boolean;
}

/** Default pause before a two-moment step moves to its second moment. */
export const DEFAULT_PHASE_MS = 1600;

export const TUTORIAL_CHAPTERS = [
  "Reading a result",
  "Checking against the image",
  "Explaining the model",
];

/** Shown instead of the tour when no result is loaded. */
export const TUTORIAL_NO_RESULT_STEP: TutorialStep = {
  id: "no-result",
  chapter: 1,
  title: "No analysis yet",
  body: ["Run or open an analysis first, then restart the tutorial."],
  notice: true,
};

export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    id: "gene-list",
    chapter: 1,
    target: "gene-list",
    // Second moment: the Cancer toggle is switched on, and spotlighted with
    // the list (GeneXApp restores it when the tour ends).
    phases: ["gene-list", "cancer-filter gene-list"],
    phaseMs: 1500,
    title: "Predicted genes",
    body: ["Genes ranked by average predicted level. The Cancer toggle keeps genes clearly higher in cancer tiles."],
  },
  {
    id: "gene-pathways",
    chapter: 1,
    // The Gene pathways window for the first gene in the list, beside the list
    // so another gene can be clicked.
    target: "gene-list enrichment-modal",
    interaction: "free",
    title: "Gene details",
    body: ["Click a gene for what it does and the pathways it takes part in. Explore gene in tissue jumps to its tissue view."],
  },
  {
    id: "gene-map",
    chapter: 1,
    target: "gene-first",
    phases: ["gene-first", "plot-card"],
    title: "Map a gene",
    body: ["Select a gene to map it. Purple is low, yellow is high."],
  },
  {
    id: "clusters",
    chapter: 1,
    // The map and breakdown, then the analysis panel; Next moves between them.
    target: "plot-card cluster-breakdown",
    phases: ["plot-card cluster-breakdown", "cluster-analysis"],
    phaseMs: 0,
    title: "Clusters",
    body: ["Each colour is a group of tiles with similar predicted gene patterns. The panel lists each group's most elevated genes; small groups are flagged."],
  },
  {
    id: "pathways",
    chapter: 1,
    target: "pathway-pills",
    phases: ["pathway-pills", "enrichment-modal"],
    interaction: "free",
    title: "Pathways",
    body: ["Pathways those genes share, with the matching genes and p-values."],
  },
  {
    id: "tissue-expression",
    chapter: 2,
    // The map and legend (hover a tile, pin a type), then the Expression
    // panel (click a gene to map it); Next moves between them.
    target: "tissue-map tissue-legend",
    phases: ["tissue-map tissue-legend", "tissue-expression tissue-genes-higher"],
    phaseMs: 0,
    phaseBodies: [
      "Hover a tile to see the model's tissue probabilities. Click a type to pin it.",
      "Click a gene in the list to map it.",
    ],
    interaction: "free",
    title: "Tissue types",
    body: ["Hover a tile to see the model's tissue probabilities. Click a type to pin it."],
  },
  {
    id: "tissue-composition",
    chapter: 2,
    target: "tissue-composition",
    title: "Tissue composition",
    body: ["Which tissue each gene group is made of."],
  },
  {
    id: "gradcam",
    chapter: 3,
    // The map and colour bar, then the detail window of the first tile that
    // has heat (skipped when none has computed yet); Next moves between them.
    target: "gradcam-map gradcam-scale",
    phases: ["gradcam-map gradcam-scale", "gradcam-detail"],
    phaseMs: 0,
    interaction: "free",
    title: "Grad-CAM",
    body: ["Warmer means more influence. Click a tile for the cells behind it. It explains the model, not the biology."],
  },
  {
    id: "header-actions",
    chapter: 3,
    target: "header-actions",
    title: "History and export",
    body: ["Every run is saved to History when signed in, and can be exported as a PDF."],
  },
  {
    id: "finish",
    chapter: 3,
    title: "That's the tour",
    body: ["Tutorial complete. Restart any time from Take the Tutorial."],
  },
];

/** What a result has to offer, which decides which steps are worth showing. */
export interface TourAvailability {
  /** The run has tissue-type data (the Tissue tab exists). */
  tissue: boolean;
  /** Grad-CAM is offered for this run's cancer type. */
  gradcam: boolean;
  /** At least one cluster has pathway results to show. */
  pathways: boolean;
}

/** The tour for a loaded result, without the steps it cannot show. */
export function buildTourSteps(available: TourAvailability): TutorialStep[] {
  return TUTORIAL_STEPS.filter((step) => {
    if (step.id === "tissue-expression" || step.id === "tissue-composition") return available.tissue;
    if (step.id === "gradcam") return available.gradcam;
    if (step.id === "pathways") return available.pathways;
    return true;
  }).map((step) =>
    // The Cancer toggle only exists on results with tissue data, and only
    // while SHOW_GENE_TISSUE_TAGS is on; without it the gene list step is the
    // plain one.
    step.id === "gene-list" && !(available.tissue && SHOW_GENE_TISSUE_TAGS)
      ? { ...step, phases: undefined, phaseMs: undefined, body: ["Genes ranked by average predicted level across the section."] }
      : step,
  );
}

/** Whether the presenter (Next/Back) moves between this step's moments, rather
 * than the tour moving on by itself. */
export function isManualPhases(step: TutorialStep): boolean {
  return Boolean(step.phases?.length) && step.phaseMs === 0;
}

/** The card text for one of a step's moments. */
export function tourBody(step: TutorialStep, phase: number): string[] {
  const text = step.phaseBodies?.[Math.max(phase, 0)];
  return text ? [text] : step.body;
}

/** The `data-tour` value a step highlights during one of its moments. */
export function tourTarget(step: TutorialStep, phase: number): string | undefined {
  if (!step.phases?.length) return step.target;
  return step.phases[Math.min(Math.max(phase, 0), step.phases.length - 1)];
}

/** The cluster whose pathways the tour shows: the one whose top term has the
 * most matched genes, else (on a tie, or when no term lists its genes) the
 * first cluster that has any pathways. Null when no cluster has any. */
export function pickTourPathwayCluster(pathways: Record<number, PathwayState>): number | null {
  let best: number | null = null;
  let bestGenes = -1;
  for (const key of Object.keys(pathways).map(Number).sort((a, b) => a - b)) {
    const state = pathways[key];
    if (state?.status !== "done" || !state.results.length) continue;
    const matched = state.results[0].genes?.length ?? 0;
    if (matched > bestGenes) {
      best = key;
      bestGenes = matched;
    }
  }
  return best;
}
