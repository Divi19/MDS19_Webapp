"use client";

import type { Prediction } from "@/lib/mockPrediction";
import {
  formatPercent, MIN_TILES, TISSUE_CLASSES, TISSUE_COLORS, TISSUE_SHORT_NAMES, type TissueClass,
} from "@/lib/tissue";

/**
 * The Tissue tab's bottom card: one tile per tissue type with its tile count
 * and share, built like the Cluster breakdown tiles on the other tabs (same
 * classes, so the same size). Types with fewer than MIN_TILES tiles are
 * marked "too few", which is why Tissue Analysis greys them out. Clicking a
 * tile pins that type, shared with the map legend and the Tissue Analysis
 * picker. GeneXApp lays this over the cluster breakdown card, so it always
 * has that card's exact height.
 */
export default function TissueBreakdown({
  pred,
  pinned = null,
  onPin,
}: {
  pred: Prediction;
  pinned?: TissueClass | null;
  onPin?: (cls: TissueClass | null) => void;
}) {
  const summary = pred.tissue!.summary;
  return (
    <div className="card tissue-breakdown">
      <div className="card-title">
        Tissue breakdown
        <span className="meta">click a type to pin it on the map</span>
      </div>
      <div className="cluster-grid">
        {TISSUE_CLASSES.map((cls) => {
          const { count, fraction } = summary[cls];
          const few = count < MIN_TILES;
          return (
            <button
              key={cls}
              type="button"
              className={`cluster-tile clickable${pinned === cls ? " pinned" : ""}${few ? " few" : ""}`}
              aria-pressed={pinned === cls}
              title={`${cls}: ${count} tiles (${formatPercent(fraction)})${few ? ` · fewer than ${MIN_TILES}, too few to compare` : ""}`}
              onClick={() => onPin?.(pinned === cls ? null : cls)}
            >
              <div className="head">
                <span className="dot" style={{ background: TISSUE_COLORS[cls] }} />
                <span className="name">{TISSUE_SHORT_NAMES[cls]}</span>
              </div>
              <div className="count" style={{ color: few ? undefined : TISSUE_COLORS[cls] }}>
                {count}
              </div>
              <div className="pct">
                {formatPercent(fraction)}
                {few && " · too few"}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
