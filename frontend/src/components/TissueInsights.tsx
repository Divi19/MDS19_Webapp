"use client";

import { useMemo, useState } from "react";
import { CL, type Prediction } from "@/lib/mockPrediction";
import {
  cancerEnrichedGenes, clusterTissueTable, formatPercent, geneByTissue, TISSUE_CLASSES, TISSUE_COLORS,
} from "@/lib/tissue";

type InsightTab = "expression" | "composition";

/**
 * The Tissue tab's bottom card. Connects the tissue classification to the
 * expression prediction:
 *  - Expression by tissue type (default): the selected gene's mean predicted
 *    expression in each tissue class, and the genes most raised in Cancer
 *    tiles versus all other tiles.
 *  - Composition: share of tiles per class, and how the expression clusters
 *    (Clusters tab) map onto tissue classes.
 * All values are model-scale predictions averaged over tiles.
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
  const maxMean = Math.max(0, ...byClass.map((c) => c.mean ?? 0));

  return (
    <div className="card cluster-card tissue-insights">
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
        <span className="meta">{tissue.version} · {pred.total} tiles</span>
      </div>

      {tab === "expression" ? (
        <div className="insight-grid" role="tabpanel">
          <section>
            <h4>
              <span className="insight-gene">{gene}</span> by tissue type
            </h4>
            {byClass.map(({ cls, count, mean }) => (
              <div key={cls} className="insight-row">
                <span className="insight-name">
                  <span className="dot" style={{ background: TISSUE_COLORS[cls] }} />
                  {cls}
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
            <p className="insight-note">Mean predicted expression per tile. Pick a gene from the list on the left or here.</p>
          </section>
          <section>
            <h4>Highest in Cancer tiles vs the rest</h4>
            {enriched.length ? (
              <table className="insight-table">
                <thead>
                  <tr>
                    <th>Gene</th>
                    <th>Cancer</th>
                    <th>Other</th>
                    <th>Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {enriched.map((row) => (
                    <tr key={row.gene} className={row.gene === gene ? "on" : ""}>
                      <td>
                        <button type="button" className="insight-gene-btn" onClick={() => onPickGene(row.gene)}>
                          {row.gene}
                        </button>
                      </td>
                      <td>{row.cancerMean.toFixed(2)}</td>
                      <td>{row.restMean.toFixed(2)}</td>
                      <td>+{row.diff.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="insight-note">Needs both Cancer and non-cancer tiles in this section.</p>
            )}
          </section>
        </div>
      ) : (
        <div role="tabpanel">
          <div className="tissue-cancer-area">
            Cancer area: <strong>{formatPercent(tissue.summary.Cancer.fraction)}</strong> of tiles
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
          <table className="insight-table crosstab">
            <thead>
              <tr>
                <th>Expression cluster</th>
                {TISSUE_CLASSES.map((name) => (
                  <th key={name} title={name}>
                    <span className="dot" style={{ background: TISSUE_COLORS[name] }} />
                    {name.split(" ")[0]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {crossTab.map((row, cluster) => {
                const total = row.reduce((a, b) => a + b, 0);
                const top = row.indexOf(Math.max(...row));
                return (
                  <tr key={cluster}>
                    <td>
                      <span className="dot" style={{ background: CL[cluster] }} />
                      cluster {cluster}
                    </td>
                    {row.map((count, i) => (
                      <td key={i} className={total && i === top ? "top" : ""}>
                        {count ? formatPercent(count / total) : "—"}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="insight-note">Share of each expression cluster&apos;s tiles in each tissue class.</p>
        </div>
      )}
    </div>
  );
}
