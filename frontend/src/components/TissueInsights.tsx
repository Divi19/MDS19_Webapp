"use client";

import { useMemo, useState } from "react";
import { CL, type Prediction } from "@/lib/mockPrediction";
import {
  cancerEnrichedGenes, cancerStatement, clusterTissueTable, formatPercent, geneByTissue, TISSUE_CLASSES,
  TISSUE_COLORS, TISSUE_SHORT_NAMES,
} from "@/lib/tissue";

type InsightTab = "expression" | "composition";

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
 * The Tissue tab's bottom card. Connects the tissue classification to the
 * expression prediction:
 *  - Expression by tissue type (default): the selected gene's mean predicted
 *    expression in each tissue class, and the genes most raised in Cancer
 *    tiles versus all other tiles.
 *  - Composition: share of tiles per class for the whole section and for each
 *    expression cluster (Clusters tab).
 * GeneXApp lays this over the cluster breakdown card, so it always has that
 * card's exact height; both sub-tabs are sized to fit it.
 */
export default function TissueInsights({
  pred,
  gene,
  onPickGene,
}: {
  pred: Prediction;
  gene: string;
  onPickGene: (gene: string) => void;
}) {
  const [tab, setTab] = useState<InsightTab>("expression");
  const tissue = pred.tissue!;

  const byClass = useMemo(() => geneByTissue(pred, gene), [pred, gene]);
  const enriched = useMemo(() => cancerEnrichedGenes(pred, 5), [pred]);
  const crossTab = useMemo(() => clusterTissueTable(pred), [pred]);
  const overall = TISSUE_CLASSES.map((name) => tissue.summary[name].count);
  const maxMean = Math.max(0, ...byClass.map((c) => c.mean ?? 0));

  return (
    <div className="card tissue-insights">
      <div className="card-title">
        <div className="seg seg-sub" role="tablist" aria-label="Tissue insights">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "expression"}
            className={tab === "expression" ? "on" : ""}
            onClick={() => setTab("expression")}
          >
            Expression by tissue type
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "composition"}
            className={tab === "composition" ? "on" : ""}
            onClick={() => setTab("composition")}
          >
            Composition
          </button>
        </div>
        <span className="meta">{cancerStatement(tissue, pred.total)}</span>
      </div>

      {tab === "expression" ? (
        <div className="insight-grid" role="tabpanel">
          <section>
            <h4 title="Mean predicted expression per tile in each tissue class. Pick a gene from the list on the left or from the right column.">
              <span className="insight-gene">{gene}</span> mean by tissue type
            </h4>
            {byClass.map(({ cls, count, mean }) => (
              <div key={cls} className="insight-row" title={`${cls}: ${count} tiles`}>
                <span className="insight-name">
                  <span className="dot" style={{ background: TISSUE_COLORS[cls] }} />
                  {TISSUE_SHORT_NAMES[cls]}
                </span>
                <span className="insight-bar">
                  {mean != null && maxMean > 0 && (
                    <span style={{ width: `${(mean / maxMean) * 100}%`, background: TISSUE_COLORS[cls] }} />
                  )}
                </span>
                <span className="insight-val">{mean == null ? "—" : mean.toFixed(2)}</span>
                <span className="insight-n">n={count}</span>
              </div>
            ))}
          </section>
          <section>
            <h4 title="Mean predicted expression in Cancer tiles minus all other tiles">Highest in Cancer vs other tiles</h4>
            {enriched.length ? (
              enriched.map((row) => (
                <div key={row.gene} className={`insight-row enriched${row.gene === gene ? " on" : ""}`}>
                  <button type="button" className="insight-gene-btn" onClick={() => onPickGene(row.gene)}>
                    {row.gene}
                  </button>
                  <span className="insight-val" title="Cancer tiles vs other tiles">
                    {row.cancerMean.toFixed(2)} vs {row.restMean.toFixed(2)}
                  </span>
                  <span className="insight-diff">+{row.diff.toFixed(2)}</span>
                </div>
              ))
            ) : (
              <p className="insight-note">Needs both Cancer and non-cancer tiles in this section.</p>
            )}
          </section>
        </div>
      ) : (
        <div className="composition" role="tabpanel">
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
      )}
    </div>
  );
}
