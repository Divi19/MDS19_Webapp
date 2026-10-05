"use client";

import type { PredictionTissue } from "@/lib/tissue";

export type SpotLayer = "expression" | "tissue";

/** "Gene expression | Tissue type" switch for the Genes view. Renders
 * nothing when the prediction has no tissue data, so predictions without it
 * look exactly as before. */
export default function TissueLayerToggle({
  tissue,
  layer,
  onChange,
}: {
  tissue: PredictionTissue | null | undefined;
  layer: SpotLayer;
  onChange: (layer: SpotLayer) => void;
}) {
  if (!tissue) return null;
  return (
    <div className="plot-subheader">
      <span className="plot-subheader-label">Colour spots by</span>
      <div className="seg seg-layer" role="group" aria-label="Colour spots by">
        <button
          type="button"
          className={layer === "expression" ? "on" : ""}
          aria-pressed={layer === "expression"}
          onClick={() => onChange("expression")}
        >
          Gene expression
        </button>
        <button
          type="button"
          className={layer === "tissue" ? "on" : ""}
          aria-pressed={layer === "tissue"}
          onClick={() => onChange("tissue")}
        >
          Tissue type
        </button>
      </div>
    </div>
  );
}
