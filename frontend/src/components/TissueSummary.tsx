"use client";

import { formatPercent, TISSUE_CLASSES, TISSUE_COLORS, type PredictionTissue } from "@/lib/tissue";

/** Whole-prediction tissue composition: cancer share, a stacked bar of every
 * class's fraction of spots, and per-class counts. Shown in place of the
 * cluster breakdown while the tissue-type layer is active. */
export default function TissueSummary({ tissue, total }: { tissue: PredictionTissue; total: number }) {
  const cancer = tissue.summary.Cancer;
  return (
    <div className="card cluster-card tissue-summary-card">
      <div className="card-title">
        Tissue composition
        <span className="meta">{tissue.version} · {total} spots</span>
      </div>
      <div className="tissue-cancer-area">
        Cancer area: <strong>{formatPercent(cancer.fraction)}</strong> of spots
      </div>
      <div
        className="tissue-stack"
        role="img"
        aria-label={TISSUE_CLASSES.map((name) => `${name} ${formatPercent(tissue.summary[name].fraction)}`).join(", ")}
      >
        {TISSUE_CLASSES.map((name) => (
          <span
            key={name}
            title={`${name}: ${formatPercent(tissue.summary[name].fraction)}`}
            style={{ width: `${tissue.summary[name].fraction * 100}%`, background: TISSUE_COLORS[name] }}
          />
        ))}
      </div>
      <div className="tissue-stats">
        {TISSUE_CLASSES.map((name) => (
          <span key={name} className="stat">
            <span className="dot" style={{ background: TISSUE_COLORS[name] }} />
            {name} {formatPercent(tissue.summary[name].fraction)} ({tissue.summary[name].count})
          </span>
        ))}
      </div>
    </div>
  );
}
