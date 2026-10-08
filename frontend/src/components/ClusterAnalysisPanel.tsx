"use client";

import { useMemo } from "react";
import { CL, type Prediction } from "@/lib/mockPrediction";
import { analyzeClusters } from "@/lib/clusterAnalysis";
import type { PathwayState } from "@/lib/pathways";

/** KEGG term names come back as "hsa05224:Breast cancer" — the pathway ID
 * prefix is noise for display, stripped here and not shown anywhere. */
function formatTerm(term: string): string {
  return term.replace(/^[a-zA-Z]+\d+:/, "");
}

export default function ClusterAnalysisPanel({
  pred,
  ready,
  hidden = false,
  pathways,
  onGeneClick,
}: {
  pred: Prediction;
  ready: boolean;
  /** Hidden (not unmounted) while the Tissue tab shows its own panel. */
  hidden?: boolean;
  /** Keyed by cluster index. Fetched and kept in GeneXApp (not here) so the
   * PDF report export can read the same already-fetched results instead of
   * re-querying DAVID. */
  pathways: Record<number, PathwayState>;
  onGeneClick: (gene: string, rect: DOMRect) => void;
}) {
  const analysis = useMemo(() => (ready ? analyzeClusters(pred) : []), [pred, ready]);

  return (
    <div className="col col-3" data-tour="cluster-analysis" hidden={hidden}>
      <div className="cluster-analysis-header">
        <div className="cluster-analysis-title">Cluster Analysis</div>
        <div className="cluster-analysis-sub">
          {ready
            ? `k=${analysis.length} · top differential genes per cluster`
            : "run a section to see cluster analysis"}
        </div>
      </div>

      <div className="cluster-analysis-list">
        {!ready
          ? CL.map((c, i) => (
              <div key={i} className="cluster-analysis-box">
                <div className="cluster-analysis-head">
                  <span className="dot" style={{ background: c }} />
                  <span className="name">Cluster {i}</span>
                </div>
                <div className="cluster-analysis-text">no predictions yet — upload a section</div>
              </div>
            ))
          : analysis.map((a) => {
              const pathwayState: PathwayState = pathways[a.index] ?? { status: "idle" };
              return (
                <div key={a.index} className="cluster-analysis-box">
                  <div className="cluster-analysis-head">
                    <span className="dot" style={{ background: CL[a.index] }} />
                    <span className="name">Cluster {a.index}</span>
                    {a.lowSample && <span className="cluster-analysis-warn">small sample</span>}
                    <span className="count">
                      {a.count} spots · {(a.fraction * 100).toFixed(1)}%
                    </span>
                  </div>

                  <div className="cluster-analysis-label">Genes found in cluster</div>
                  <div className="cluster-analysis-genes">
                    {a.markers.length ? (
                      a.markers.map((m) => (
                        <button
                          key={m.name}
                          type="button"
                          className="cluster-analysis-gene"
                          onClick={(e) => onGeneClick(m.name, e.currentTarget.getBoundingClientRect())}
                        >
                          {m.name}
                        </button>
                      ))
                    ) : (
                      <span className="cluster-analysis-text">none</span>
                    )}
                  </div>

                  <div className="cluster-analysis-label">Analysis</div>
                  <div className="cluster-analysis-text">{a.summary}</div>

                  <div className="cluster-analysis-label cluster-analysis-label-row">
                    Pathways
                    <span
                      className="info-icon"
                      tabIndex={0}
                      data-tooltip="Biological pathways this cluster's genes are significantly linked to, from DAVID's KEGG enrichment analysis. No pathways shown just means none reached significance. It does not mean the genes have no known function."
                    >
                      i
                    </span>
                  </div>
                  {(pathwayState.status === "idle" || pathwayState.status === "loading") && (
                    <div className="cluster-analysis-text">looking up…</div>
                  )}
                  {pathwayState.status === "error" && (
                    <div className="cluster-analysis-text">{pathwayState.message}</div>
                  )}
                  {pathwayState.status === "done" && (
                    <div className="cluster-analysis-genes">
                      {pathwayState.results.length ? (
                        pathwayState.results
                          .slice(0, 3)
                          .map((r) => (
                            <span
                              key={r.term}
                              className="cluster-analysis-pathway"
                              style={{ color: CL[a.index], background: `${CL[a.index]}20` }}
                            >
                              {formatTerm(r.term)}
                            </span>
                          ))
                      ) : (
                        <span className="cluster-analysis-text">no significant KEGG pathways found</span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
      </div>
    </div>
  );
}
