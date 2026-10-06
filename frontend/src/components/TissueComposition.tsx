"use client";

import { useMemo } from "react";
import { CL, type Prediction } from "@/lib/mockPrediction";
import { clusterTissueTable, formatPercent, TISSUE_CLASSES, TISSUE_COLORS } from "@/lib/tissue";

/** One horizontal stacked bar of tissue-class counts, with the breakdown in
 * its tooltip and accessible name. */
function CompositionBar({ counts }: { counts: number[] }) {
  const total = counts.reduce((a, b) => a + b, 0);
  const label = TISSUE_CLASSES.map((name, i) => `${name} ${formatPercent(total ? counts[i] / total : 0)}`).join(", ");
  return (
    <span className="tissue-stack" role="img" aria-label={label} title={label}>
      {TISSUE_CLASSES.map((name, i) => (
        <span key={name} style={{ width: `${total ? (counts[i] / total) * 100 : 0}%`, background: TISSUE_COLORS[name] }} />
      ))}
    </span>
  );
}

/**
 * The Tissue tab's bottom card: share of tiles per tissue type for the whole
 * section and for each expression cluster (Clusters tab). The expression
 * analysis lives in column 3 (TissueAnalysisPanel).
 * GeneXApp lays this over the cluster breakdown card, so it always has that
 * card's exact height.
 */
export default function TissueComposition({ pred }: { pred: Prediction }) {
  const tissue = pred.tissue!;
  const crossTab = useMemo(() => clusterTissueTable(pred), [pred]);
  const overall = TISSUE_CLASSES.map((name) => tissue.summary[name].count);

  return (
    <div className="card tissue-composition">
      <div className="card-title">
        Tissue composition
        <span className="meta">{pred.total} tiles classified</span>
      </div>
      <div className="composition">
        <div className="composition-row overall">
          <span className="composition-label">All tiles</span>
          <CompositionBar counts={overall} />
        </div>
        {crossTab.map((counts, cluster) => (
          <div key={cluster} className="composition-row">
            <span className="composition-label">
              <span className="dot" style={{ background: CL[cluster] }} />
              cluster {cluster}
            </span>
            <CompositionBar counts={counts} />
          </div>
        ))}
      </div>
    </div>
  );
}
