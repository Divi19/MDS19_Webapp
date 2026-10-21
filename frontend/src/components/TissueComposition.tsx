"use client";

import { useMemo } from "react";
import { CL, type Prediction } from "@/lib/mockPrediction";
import {
  clusterTissueLabels, clusterTissueTable, formatPercent, TISSUE_CLASSES, TISSUE_COLORS, TISSUE_SHORT_NAMES,
} from "@/lib/tissue";

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

/** The non-zero types of a row as text, largest first, e.g.
 * "107 Cancer · 1 Connective" (counts) or "Cancer 74% · Connective 23%". */
function breakdownText(counts: number[], asShare: boolean): string {
  const total = counts.reduce((a, b) => a + b, 0);
  return TISSUE_CLASSES.map((cls, i) => ({ cls, n: counts[i] }))
    .filter((p) => p.n > 0)
    .sort((a, b) => b.n - a.n)
    .map((p) =>
      asShare
        ? `${TISSUE_SHORT_NAMES[p.cls]} ${p.n / total < 0.005 ? "<1" : Math.round((p.n / total) * 100)}%`
        : `${p.n} ${TISSUE_SHORT_NAMES[p.cls]}`,
    )
    .join(" · ");
}

/**
 * The Composition tab of Tissue Analysis (right pane, Tissue tab): which
 * tissue types make up the whole section and each expression cluster
 * (Clusters tab), with the counts written out. Hovering a cluster highlights
 * its tiles on the Tissue map; clicking locks that highlight.
 */
export default function TissueComposition({
  pred,
  onHoverCluster,
  pinnedCluster = null,
  onPinCluster,
}: {
  pred: Prediction;
  onHoverCluster?: (cluster: number | null) => void;
  /** The cluster locked on the map; click a card to lock or unlock it. */
  pinnedCluster?: number | null;
  onPinCluster?: (cluster: number | null) => void;
}) {
  const crossTab = useMemo(() => clusterTissueTable(pred), [pred]);
  const labels = useMemo(() => clusterTissueLabels(pred), [pred]);
  const overall = TISSUE_CLASSES.map((name) => pred.tissue!.summary[name].count);

  return (
    <div className="composition">
      <section className="cluster-analysis-box composition-row overall">
        <div className="composition-head">
          <span className="composition-label">All tiles</span>
          <span className="insight-n">{pred.total} tiles</span>
        </div>
        <CompositionBar counts={overall} />
        <p className="cluster-analysis-text">{breakdownText(overall, true)}</p>
      </section>
      <p className="cluster-analysis-text composition-intro">
        Each expression cluster (Clusters tab) by the tissue types of its tiles. Hover a cluster to see its tiles on the
        map, or click to lock it.
      </p>
      {crossTab.map((counts, cluster) => {
        const total = counts.reduce((a, b) => a + b, 0);
        if (!total) return null;
        return (
          <section
            key={cluster}
            role="button"
            tabIndex={0}
            aria-pressed={pinnedCluster === cluster}
            className={`cluster-analysis-box composition-row clickable${pinnedCluster === cluster ? " pinned" : ""}${
              pinnedCluster != null && pinnedCluster !== cluster ? " dimmed" : ""
            }`}
            onMouseEnter={() => onHoverCluster?.(cluster)}
            onMouseLeave={() => onHoverCluster?.(null)}
            onClick={() => onPinCluster?.(pinnedCluster === cluster ? null : cluster)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onPinCluster?.(pinnedCluster === cluster ? null : cluster);
              }
            }}
          >
            <div className="composition-head">
              <span className="composition-label">
                <span className="dot" style={{ background: CL[cluster] }} />
                cluster {cluster}
                {labels[cluster] && <span className="cluster-tissue">{labels[cluster]!.full}</span>}
              </span>
              <span className="insight-n">{total} tiles</span>
            </div>
            <CompositionBar counts={counts} />
            <p className="cluster-analysis-text">{breakdownText(counts, false)}</p>
          </section>
        );
      })}
    </div>
  );
}
