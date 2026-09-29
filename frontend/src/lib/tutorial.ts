/**
 * Guided tutorial content.
 *
 * Each step highlights one element marked with a matching `data-tour`
 * attribute. Steps without a target render as a centred card. The workspace
 * (GeneXApp) owns the step state and prepares the page for each step —
 * opening History or the upload window, switching views — so this file only
 * describes what is shown.
 */

export type TutorialInteraction =
  /** The highlighted element is clickable, and clicking it advances the
   * tutorial. Next performs the same click on the user's behalf. */
  | "advance"
  /** The highlighted element is clickable, but clicking it does not advance
   * the tutorial (for example, choosing a file in the upload window). */
  | "free";

export type TutorialPlacement = "top" | "bottom" | "left" | "right";

export interface TutorialStep {
  id: string;
  chapter: number;
  /** Value of the `data-tour` attribute to highlight. */
  target?: string;
  title: string;
  body: string[];
  interaction?: TutorialInteraction;
  /** Shown beneath the body on steps the user can act on directly. */
  actionHint?: string;
  /** Shown instead of the action hint when the target is not on the page. */
  missingTargetNote?: string;
  placement?: TutorialPlacement;
}

export const TUTORIAL_CHAPTERS = [
  "Welcome",
  "Saved analyses",
  "Reading a result",
  "Exploring genes",
  "Analysing your own section",
];

/** Shown between choosing a saved analysis and Chapter 3, while the result
 * is still loading, so the tutorial never points at empty panels. */
export const TUTORIAL_LOADING_STEP: TutorialStep = {
  id: "history-loading",
  chapter: 2,
  title: "Loading the saved analysis",
  body: [
    "Retrieving the predicted expression for every tile of the section. This usually takes a few seconds; the tutorial continues automatically once it has loaded.",
  ],
};

export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    id: "welcome",
    chapter: 1,
    title: "Welcome to GeneX",
    body: [
      "GeneX predicts spatial gene expression from H&E-stained histology images using the mclSTExp model, trained on HER2-positive breast cancer tissue.",
      "This tutorial introduces each part of the workspace in five short chapters and takes approximately two minutes. You can leave at any time and restart it from the Take the Tutorial button at the top of the page.",
      "All values shown are model predictions for research use. They are not laboratory measurements.",
    ],
  },
  {
    id: "sign-in",
    chapter: 2,
    target: "sign-in",
    interaction: "free",
    title: "Sign in to access saved analyses",
    body: [
      "Saved analyses are stored per account. Sign in with the account provided to you to open the example analyses it contains.",
    ],
    actionHint:
      "Select Sign in to open the example analyses; the tutorial resumes once you are signed in. Choose Next to continue without signing in.",
  },
  {
    id: "history-button",
    chapter: 2,
    target: "history",
    interaction: "advance",
    title: "Open your saved analyses",
    body: [
      "History lists every analysis run while signed in to this account. This account includes example analyses, so you can review a complete result without uploading an image.",
    ],
    actionHint: "Select History to continue.",
  },
  {
    id: "history-entry",
    chapter: 2,
    target: "history-entry",
    interaction: "advance",
    title: "Open a saved analysis",
    body: [
      "Each entry shows a thumbnail of the section, its file name and the date it was analysed. The bin icon on the right of an entry permanently deletes it.",
    ],
    actionHint: "Select any of the highlighted entries to load it. Next opens the most recent one.",
    missingTargetNote: "No saved analyses are available on this account yet. Continue to see how a result is presented.",
  },
  {
    id: "input-card",
    chapter: 3,
    target: "input-card",
    title: "The analysed section",
    body: [
      "The section being viewed appears here, together with the gene the model predicts to be most highly expressed across the tissue.",
    ],
  },
  {
    id: "spatial-map",
    chapter: 3,
    target: "plot-card",
    title: "Spatial map",
    body: [
      "The tissue is divided into 224 × 224 pixel tiles, and each point on the map represents one tile. The model predicts the expression of 785 genes for every tile.",
      "In the Clusters view, tiles with similar predicted expression profiles are grouped into five clusters and coloured accordingly. Hover over a point to see its details.",
      "The tabs above the map switch between the Clusters, Genes and Grad-CAM views.",
    ],
  },
  {
    id: "cluster-breakdown",
    chapter: 3,
    target: "cluster-breakdown",
    title: "Cluster breakdown",
    body: [
      "The number of tiles assigned to each cluster, and the proportion of the section each cluster represents. Colours correspond to the map above.",
    ],
  },
  {
    id: "cluster-analysis",
    chapter: 3,
    target: "cluster-analysis",
    title: "Cluster analysis",
    body: [
      "For each cluster, the listed genes are those whose predicted expression is most elevated in that cluster relative to the rest of the section. They describe differences in predicted expression and do not identify cell types.",
      "Clusters labelled Small sample contain few tiles, so their gene lists should be interpreted with caution.",
    ],
  },
  {
    id: "gene-reference",
    chapter: 3,
    target: "gene-popover",
    interaction: "free",
    title: "Gene reference information",
    body: [
      "Selecting any gene name, here or in the gene list, opens a short description of the gene retrieved from MyGene.info, which aggregates NCBI, Ensembl and UniProt annotations.",
    ],
  },
  {
    id: "gene-list",
    chapter: 4,
    target: "gene-list",
    title: "Predicted gene expression",
    body: [
      "Every gene in the panel, ranked by its average predicted expression across the section.",
      "Value is the mean predicted expression across all tiles, on the model's normalised expression scale. The bar shows each value relative to the highest-ranked gene.",
      "Level indicates whether a gene falls in the top (High), middle (Mid) or bottom (Low) third of this ranking for the current section. It is a relative ranking, not a clinical threshold.",
      "Table and Cards change the layout, and the page controls move through the full panel.",
    ],
  },
  {
    id: "gene-select",
    chapter: 4,
    target: "gene-first",
    interaction: "advance",
    title: "Map a single gene",
    body: ["Selecting a gene displays its predicted expression across the tissue."],
    actionHint: "Select the highlighted gene to continue.",
  },
  {
    id: "genes-view",
    chapter: 4,
    target: "plot-card",
    title: "Genes view",
    body: [
      "The map now shows the predicted expression of the selected gene for every tile, from low (dark purple) to high (yellow).",
      "The gene selector above the map chooses another gene; its filters narrow the list to High, Mid or Low genes, or to well-known markers. Show image places the tissue section beneath the expression overlay.",
    ],
  },
  {
    id: "gradcam",
    chapter: 4,
    target: "plot-card",
    title: "Grad-CAM",
    body: [
      "Grad-CAM highlights the regions within each tile that most influenced the model, measured against the section's top predicted gene. Warmer colours indicate greater influence.",
      "Tiles are computed progressively, and a full section can take several minutes. The computation continues while you use other views. Drag to pan, scroll to zoom, and select a tile to enlarge it.",
      "Grad-CAM explains the model's behaviour. It does not localise biological activity.",
    ],
  },
  {
    id: "upload",
    chapter: 5,
    target: "upload-action",
    title: "Analyse your own section",
    body: [
      "Upload H&E section opens the upload window; the keyboard shortcut U does the same. Reset clears the current workspace.",
    ],
  },
  {
    id: "upload-window",
    chapter: 5,
    target: "upload-body",
    interaction: "free",
    title: "Choose an image",
    body: [
      "Drag an H&E image onto the drop area, or select the area to browse. TIFF, PNG and JPEG files up to 50 MB are accepted.",
      "If you do not have a section available, use the sample H&E image. The file name, size, dimensions and status appear once an image is selected.",
    ],
  },
  {
    id: "upload-run",
    chapter: 5,
    target: "upload-run",
    interaction: "free",
    title: "Run the prediction",
    body: [
      "Run prediction sends the image to the model. Processing time depends on the size of the section. While you are signed in, each result is saved to History automatically.",
    ],
    actionHint: "Selecting Run prediction ends the tutorial and starts the analysis.",
  },
  {
    id: "header-actions",
    chapter: 5,
    target: "header-actions",
    title: "Export and account",
    body: [
      "Export downloads the ranked gene list as an Excel workbook. History reopens saved analyses, and the account menu provides access to your profile and to sign out.",
    ],
  },
  {
    id: "finish",
    chapter: 5,
    title: "Tutorial complete",
    body: [
      "You are now familiar with the GeneX workspace. You can restart this tutorial at any time using the Take the Tutorial button at the top of the page.",
    ],
  },
];
