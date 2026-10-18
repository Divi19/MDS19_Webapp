"use client";

import { useEffect, useState } from "react";

export const PIPELINE_STEPS = [
  "loading checkpoint",
  "tiling H&E into spot patches",
  "extracting image embeddings",
  "contrastive matching to expression",
  "predicting 785 genes per spot",
  "K-means clustering (k=5)",
  "saving predictions",
];

const SUBTEXT = [
  "loading checkpoint…",
  "tiling H&E into spot patches…",
  "extracting image embeddings…",
  "contrastive matching…",
  "predicting 785 genes…",
  "K-means (k=5)…",
  "saving predictions…",
];

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 100) / 10;
  const m = Math.floor(total / 60);
  const sec = (total - m * 60).toFixed(1).padStart(4, "0");
  return m > 0 ? `${m}:${sec}` : `${total.toFixed(1)}s`;
}

export default function ProgressOverlay({
  visible,
  stepIndex,
}: {
  visible: boolean;
  stepIndex: number;
}) {
  const done = stepIndex >= PIPELINE_STEPS.length;
  const fill = done ? 100 : ((stepIndex + 1) / PIPELINE_STEPS.length) * 100;
  const [elapsedMs, setElapsedMs] = useState(0);

  // Runs from the moment the overlay appears until the last step finishes,
  // then holds the final time. Restarts at 0 on the next run.
  useEffect(() => {
    if (!visible || done) return;
    const start = performance.now();
    const tick = () => setElapsedMs(performance.now() - start);
    queueMicrotask(tick);
    const id = setInterval(tick, 100);
    return () => {
      tick();
      clearInterval(id);
    };
  }, [visible, done]);

  const sub = done ? "done · rendering results" : SUBTEXT[stepIndex] ?? SUBTEXT[0];

  return (
    <div className={`progress-overlay${visible ? " visible" : ""}`}>
      <div className="progress-card">
        <div className="progress-head">
          <h3>Running Prediction…</h3>
          <span className="progress-timer" aria-label="Elapsed time">{formatElapsed(elapsedMs)}</span>
        </div>
        <div className="sub">{sub}</div>
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${fill}%` }} />
        </div>
        <div className="steps">
          {PIPELINE_STEPS.map((label, i) => {
            const cls =
              done || i < stepIndex ? "step done" : i === stepIndex ? "step active" : "step";
            return (
              <div key={label} className={cls}>
                <span className="ico" />
                {label}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
