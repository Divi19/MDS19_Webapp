"use client";

import { useMemo } from "react";
import { CL, type Prediction } from "@/lib/mockPrediction";
import { analyzeClusters } from "@/lib/clusterAnalysis";
import type { PathwayState } from "@/lib/pathways";
import { clusterTissueLabels } from "@/lib/tissue";

/** Strips each category's own ID prefix — noise for display, never shown.
 * KEGG: "hsa05224:Breast cancer". Reactome and GO both use a tilde instead
 * of a bare colon: "R-HSA-1306955~GRB7 events in ERBB2 signaling",
 * "GO:0007173~epidermal growth factor receptor signaling pathway" (GO's own
 * "GO:0007173" would survive a colon-only strip, so tilde is checked
 * first). */
function formatTerm(term: string): string {
  const afterTilde = term.split("~");
  if (afterTilde.length > 1) return afterTilde.slice(1).join("~");
  return term.replace(/^[a-zA-Z]+\d+:/, "");
}

export default function ClusterAnalysisPanel({
  pred,
  ready,
  hidden = false,
  pathways,
  onRetryPathways,
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
  onRetryPathways: (clusterIndex: number) => void;
  onGeneClick: (gene: string, rect: DOMRect) => void;
}) {
  const analysis = useMemo(() => (ready ? analyzeClusters(pred) : []), [pred, ready]);
  // Tissue name per cluster from the tissue classifier; null without it.
  const labels = useMemo(() => clusterTissueLabels(pred), [pred]);

  return (
    <div className="col col-3 glass" data-tour="cluster-analysis" hidden={hidden}>
      <div className="cluster-analysis-header">
        <div className="cluster-analysis-title">
          Cluster Analysis
          <span
            className="info-icon tooltip-below"
            tabIndex={0}
            data-tooltip="Groups tissue spots by how similar their predicted gene expression is, using k-means clustering. Spots with similar expression patterns land in the same cluster, so each cluster represents a distinct region of the tissue with its own gene activity profile."
          >
            i
          </span>
        </div>
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
                    {labels[a.index] && (
                      <span className="cluster-tissue" title="Tissue types of this cluster's tiles (Tissue tab)">
                        {labels[a.index]!.full}
                      </span>
                    )}
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
                      data-tooltip="Biological pathways and processes this cluster's genes are significantly linked to, found by searching KEGG, Reactome, and GO Biological Process together through DAVID. No pathways shown just means none reached significance. It does not mean the genes have no known function."
                    >
                      i
                    </span>
                  </div>
                  {(pathwayState.status === "idle" || pathwayState.status === "loading") && (
                    <div className="cluster-analysis-text">looking up…</div>
                  )}
                  {pathwayState.status === "error" && (
                    <div className="cluster-analysis-text">
                      {pathwayState.message}{" "}
                      <button type="button" onClick={() => onRetryPathways(a.index)}>
                        Retry
                      </button>
                    </div>
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
                            >
                              {formatTerm(r.term)}
                            </span>
                          ))
                      ) : (
                        <span className="cluster-analysis-text">no significant pathways found</span>
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
