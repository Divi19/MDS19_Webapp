"use client";

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

export default function ProgressOverlay({
  visible,
  stepIndex,
}: {
  visible: boolean;
  stepIndex: number;
}) {
  const done = stepIndex >= PIPELINE_STEPS.length;
  const fill = done ? 100 : ((stepIndex + 1) / PIPELINE_STEPS.length) * 100;
  const sub = done ? "done · rendering results" : SUBTEXT[stepIndex] ?? SUBTEXT[0];

  return (
    <div className={`progress-overlay${visible ? " visible" : ""}`}>
      <div className="progress-card">
        <h3>Running Prediction…</h3>
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
