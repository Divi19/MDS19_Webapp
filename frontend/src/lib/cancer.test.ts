import { describe, expect, it } from "vitest";
import { toPrediction } from "@/lib/api";
import { cancerFromApi, gradcamAvailable, gradcamExperimental } from "@/lib/cancer";
import { OLD_RESPONSE } from "@/test/fixtures";

const COAD = {
  code: "COAD", label: "Colon adenocarcinoma", prob: 0.94,
  supported: true, reason: null, limited_support: false, overridden: false,
};

describe("cancer", () => {
  it("reads the router verdict and the top-level limited_support", () => {
    expect(cancerFromApi({ tissue: { ...COAD, code: "PAAD" }, limited_support: true })).toEqual({
      code: "PAAD", label: "Colon adenocarcinoma", prob: 0.94, limitedSupport: true, overridden: false,
    });
  });

  it("is null for breast-only backends and History runs", () => {
    expect(cancerFromApi({})).toBeNull();
    expect(cancerFromApi({ tissue: null })).toBeNull();
    expect(toPrediction(OLD_RESPONSE).cancer).toBeNull();
  });

  it("keeps Grad-CAM for breast and for runs without a router verdict", () => {
    expect(gradcamAvailable(null)).toBe(true);
    expect(gradcamAvailable(cancerFromApi({ tissue: { ...COAD, code: "IDC" } }))).toBe(true);
  });

  it("shows Grad-CAM for every other cancer too", () => {
    for (const code of ["COAD", "LYMPH_IDC", "CSCC", "EPM", "BLCA"]) {
      expect(gradcamAvailable(cancerFromApi({ tissue: { ...COAD, code } }))).toBe(true);
    }
  });

  it("labels Grad-CAM experimental for non-breast cancers only", () => {
    expect(gradcamExperimental(null)).toBe(false);
    expect(gradcamExperimental(cancerFromApi({ tissue: { ...COAD, code: "IDC" } }))).toBe(false);
    expect(gradcamExperimental(cancerFromApi({ tissue: COAD }))).toBe(true);
    expect(gradcamExperimental(cancerFromApi({ tissue: { ...COAD, code: "LYMPH_IDC" } }))).toBe(true);
  });
});
