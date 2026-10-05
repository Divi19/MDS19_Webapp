"use client";

import { useMemo, useState } from "react";
import { CL, type Prediction } from "@/lib/mockPrediction";
import { analyzeClusters } from "@/lib/clusterAnalysis";
import { fetchPathways, type PathwayResult } from "@/lib/pathways";

/** KEGG term names come back as "hsa05224:Breast cancer" — the pathway ID
 * prefix is noise for display, stripped here and not shown anywhere. */
function formatTerm(term: string): string {
  return term.replace(/^[a-zA-Z]+\d+:/, "");
}

type PathwayState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "done"; results: PathwayResult[] };

export default function ClusterAnalysisPanel({
  pred,
  ready,
  onGeneClick,
}: {
  pred: Prediction;
  ready: boolean;
  onGeneClick: (gene: string, rect: DOMRect) => void;
}) {
  const analysis = useMemo(() => (ready ? analyzeClusters(pred) : []), [pred, ready]);

  // Keyed by cluster index. Pathway lookups are opt-in (a button, not
  // automatic) — DAVID caps registered accounts at 200 lookups/day, so
  // firing one per cluster on every prediction would burn through that
  // fast across a few users' sessions.
  const [pathways, setPathways] = useState<Record<number, PathwayState>>({});
  // Which pathway term (if any) is expanded, per cluster — click to show
  // its p-value and contributing genes inline, click again to collapse.
  const [expanded, setExpanded] = useState<Record<number, string | null>>({});

  async function findPathways(clusterIndex: number, genes: string[]) {
    setPathways((prev) => ({ ...prev, [clusterIndex]: { status: "loading" } }));
    try {
      const results = await fetchPathways(genes);
      setPathways((prev) => ({ ...prev, [clusterIndex]: { status: "done", results } }));
    } catch (e) {
      const message = e instanceof Error ? e.message : "Pathway lookup failed";
      setPathways((prev) => ({ ...prev, [clusterIndex]: { status: "error", message } }));
    }
  }

  return (
    <div className="col col-3" data-tour="cluster-analysis">
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

                  <div className="cluster-analysis-label">Pathways</div>
                  {pathwayState.status === "idle" && (
                    <button
                      type="button"
                      className="cluster-analysis-pathway-btn"
                      disabled={!a.markers.length}
                      onClick={() => findPathways(a.index, a.markers.map((m) => m.name))}
                    >
                      Find pathways
                    </button>
                  )}
                  {pathwayState.status === "loading" && (
                    <div className="cluster-analysis-text">looking up…</div>
                  )}
                  {pathwayState.status === "error" && (
                    <div className="cluster-analysis-text">{pathwayState.message}</div>
                  )}
                  {pathwayState.status === "done" && (
                    <>
                      <div className="cluster-analysis-genes">
                        {pathwayState.results.length ? (
                          pathwayState.results.slice(0, 3).map((r) => {
                            const isOpen = expanded[a.index] === r.term;
                            return (
                              <button
                                key={r.term}
                                type="button"
                                className={`cluster-analysis-pathway${isOpen ? " on" : ""}`}
                                onClick={() =>
                                  setExpanded((prev) => ({
                                    ...prev,
                                    [a.index]: prev[a.index] === r.term ? null : r.term,
                                  }))
                                }
                              >
                                {formatTerm(r.term)}
                              </button>
                            );
                          })
                        ) : (
                          <span className="cluster-analysis-text">no significant KEGG pathways found</span>
                        )}
                      </div>
                      {(() => {
                        const detail = pathwayState.results.find((r) => r.term === expanded[a.index]);
                        return detail ? (
                          <div className="cluster-analysis-pathway-detail">
                            FDR={detail.benjamini.toFixed(3)} · genes: {detail.genes.join(", ")}
                          </div>
                        ) : null;
                      })()}
                    </>
                  )}
                </div>
              );
            })}
      </div>
    </div>
  );
}
