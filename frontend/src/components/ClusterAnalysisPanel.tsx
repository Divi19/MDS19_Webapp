"use client";

import { useMemo } from "react";
import { CL, type Prediction } from "@/lib/mockPrediction";
import { analyzeClusters } from "@/lib/clusterAnalysis";

export default function ClusterAnalysisPanel({
  pred,
  ready,
}: {
  pred: Prediction;
  ready: boolean;
}) {
  const analysis = useMemo(() => (ready ? analyzeClusters(pred) : []), [pred, ready]);

  return (
    <div className="col col-3">
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
          : analysis.map((a) => (
              <div key={a.index} className="cluster-analysis-box">
                <div className="cluster-analysis-head">
                  <span className="dot" style={{ background: CL[a.index] }} />
                  <span className="name">Cluster {a.index}</span>
                  <span className="count">
                    {a.count} spots · {(a.fraction * 100).toFixed(1)}%
                  </span>
                </div>

                <div className="cluster-analysis-label">Genes found in cluster</div>
                <div className="cluster-analysis-genes">
                  {a.markers.length ? (
                    a.markers.map((m) => (
                      <span key={m.name} className="cluster-analysis-gene">
                        {m.name}
                      </span>
                    ))
                  ) : (
                    <span className="cluster-analysis-text">none</span>
                  )}
                </div>

                <div className="cluster-analysis-label">Analysis</div>
                <div className="cluster-analysis-text">{a.summary}</div>
              </div>
            ))}
      </div>
    </div>
  );
}
