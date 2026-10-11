/**
 * Multi-cancer serving: the tissue router's verdict for a whole slide (the
 * API's `tissue` field), i.e. which cancer model made the prediction.
 *
 * Not to be confused with Prediction.tissue (lib/tissue.ts), which is the
 * per-spot tissue-type classifier (cancer / connective / adipose ...).
 */

/** The API's `tissue` object, as the multi-cancer Modal app returns it. */
export interface ApiCancerTissue {
  /** Router class of the model used, e.g. "IDC" (breast) or "COAD". The
   * user's choice when they overrode the router. */
  code: string;
  label?: string | null;
  prob?: number | null;
  supported?: boolean | null;
  reason?: string | null;
  limited_support?: boolean | null;
  overridden?: boolean | null;
  /** The router's own answer, present only when the user overrode it. */
  router_code?: string | null;
}

export interface CancerTissue {
  code: string;
  label: string;
  /** Router confidence (0-1); null when unknown. */
  prob: number | null;
  limitedSupport: boolean;
  overridden: boolean;
}

/** Null when the backend has no tissue router (breast-only HER2ST serving,
 * the dummy predictor) or the run was saved without it. */
export function cancerFromApi(response: {
  tissue?: ApiCancerTissue | null;
  limited_support?: boolean | null;
}): CancerTissue | null {
  const t = response.tissue;
  if (!t || typeof t.code !== "string" || !t.code) return null;
  return {
    code: t.code,
    label: t.label || t.code,
    prob: typeof t.prob === "number" && Number.isFinite(t.prob) ? t.prob : null,
    limitedSupport: Boolean(response.limited_support ?? t.limited_support),
    overridden: Boolean(t.overridden),
  };
}

/**
 * Router classes Grad-CAM is shown for. The multi-cancer Grad-CAM service is
 * only verified for breast until its staging check passes; then set this to
 * null to show Grad-CAM for every cancer.
 */
const GRADCAM_ONLY_FOR: readonly string[] | null = ["IDC"];

/** Whether the Grad-CAM view is offered for a prediction. Predictions without
 * a router verdict come from breast-only serving, so they keep Grad-CAM. */
export function gradcamAvailable(cancer: CancerTissue | null | undefined): boolean {
  return !cancer || GRADCAM_ONLY_FOR === null || GRADCAM_ONLY_FOR.includes(cancer.code);
}
