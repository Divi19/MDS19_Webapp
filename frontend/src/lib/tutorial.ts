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
      "GeneX predicts spatial gene expression from H&E images of HER2-positive breast cancer tissue. All values are model predictions for research use, not laboratory measurements.",
      "This two-minute tutorial has five short chapters. You can restart it at any time from Take the Tutorial.",
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
      "Sign in to continue: select Sign in or Next. The tutorial resumes once you are signed in.",
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
      "Each point is one tile of tissue, with 785 genes predicted for it. In the Clusters view, tiles with similar predictions share a colour. Hover over a point for details.",
      "The tabs above switch between the Clusters, Genes and Grad-CAM views.",
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
      "The genes most elevated in each cluster compared with the rest of the section. They show predicted differences, not cell types. Interpret clusters marked Small sample with caution.",
    ],
  },
  {
    id: "gene-reference",
    chapter: 3,
    target: "gene-popover",
    interaction: "free",
    title: "Gene reference information",
    body: [
      "Selecting a gene name here opens a short description retrieved from MyGene.info, which aggregates NCBI, Ensembl and UniProt annotations. Selecting a gene in the gene list opens that description together with the pathways the gene takes part in.",
    ],
  },
  {
    id: "gene-list",
    chapter: 4,
    target: "gene-list",
    title: "Predicted gene expression",
    body: [
      "Every gene, ranked by its average predicted expression across the section. Value is that average, on the model's normalised scale; it is not a raw count.",
      "Level shows whether a gene is in the top, middle or bottom third for this section. It is a relative ranking, not a clinical threshold.",
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
      "The map now shows the selected gene's predicted expression, from low (dark purple) to high (yellow).",
      "Use the selector above to choose another gene, and Show image to see the tissue underneath.",
    ],
  },
  {
    id: "gradcam",
    chapter: 4,
    target: "plot-card",
    title: "Grad-CAM",
    body: [
      "Highlights the parts of each tile that most influenced the model for the section's top gene. Warmer colours mean greater influence.",
      "It fills in over several minutes and keeps going while you use other views. It explains the model's behaviour and does not localise biological activity.",
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
      "Drag an H&E image here or select the area to browse (TIFF, PNG or JPEG, up to 50 MB). If you do not have a section available, use the sample H&E image.",
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
      "Export PDF Report downloads a report of the current analysis. History reopens saved analyses, and the account menu provides access to your profile and to sign out.",
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
