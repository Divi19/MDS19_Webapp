"use client";

import { useEffect, useMemo, useState } from "react";
import { CL, type Prediction } from "@/lib/mockPrediction";
import { analyzeClusters } from "@/lib/clusterAnalysis";
import { clusterTissueLabels } from "@/lib/tissue";
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
  hidden = false,
  onGeneClick,
}: {
  pred: Prediction;
  ready: boolean;
  /** Hidden (not unmounted) while the Tissue tab shows its own panel. */
  hidden?: boolean;
  onGeneClick: (gene: string, rect: DOMRect) => void;
}) {
  const analysis = useMemo(() => (ready ? analyzeClusters(pred) : []), [pred, ready]);
  // Tissue name per cluster from the tissue classifier; null without it.
  const labels = useMemo(() => clusterTissueLabels(pred), [pred]);

  // Keyed by cluster index. Lookups fire automatically as soon as a
  // prediction's clusters are known — DAVID caps registered accounts at
  // 200 lookups/day (~40 full runs at k=5), acceptable for a small team
  // tool but worth revisiting if usage grows.
  //
  // Cluster index alone doesn't identify which prediction a lookup belongs
  // to — "cluster 2" in one upload has nothing to do with "cluster 2" in
  // the next — so every new `analysis` (keyed off pred+ready) replaces the
  // whole map rather than merging into it, dropping any stale result.
  const [pathways, setPathways] = useState<Record<number, PathwayState>>({});

  useEffect(() => {
    if (!analysis.length) {
      queueMicrotask(() => setPathways({}));
      return;
    }
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setPathways(() => {
        const next: Record<number, PathwayState> = {};
        analysis.forEach((a) => {
          next[a.index] = a.markers.length ? { status: "loading" } : { status: "done", results: [] };
        });
        return next;
      });
      analysis.forEach((a) => {
        if (!a.markers.length) return;
        fetchPathways(a.markers.map((m) => m.name))
          .then((results) => {
            if (cancelled) return;
            setPathways((prev) => ({ ...prev, [a.index]: { status: "done", results } }));
          })
          .catch((e) => {
            if (cancelled) return;
            const message = e instanceof Error ? e.message : "Pathway lookup failed";
            setPathways((prev) => ({ ...prev, [a.index]: { status: "error", message } }));
          });
      });
    });
    return () => {
      cancelled = true;
    };
  }, [analysis]);

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
