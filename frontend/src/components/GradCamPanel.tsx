"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { explainGradcam } from "@/lib/api";
import type { Prediction } from "@/lib/mockPrediction";

export default function GradCamPanel({
  pred,
  ready,
  file,
  gene,
}: {
  pred: Prediction;
  ready: boolean;
  file: File | null;
  gene: string;
}) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const urlRef = useRef<string | null>(null);
  const seqRef = useRef(0);

  // The single tile predicted to express this gene most strongly — replaces
  // blindly paging through hundreds of tiles with "Next tile". Grad-CAM then
  // explains why THAT specific hotspot looks the way it does for this gene.
  const spotIndex = useMemo(() => {
    if (!pred.spots.length) return 0;
    let best = 0;
    let bestVal = -Infinity;
    pred.spots.forEach((s, i) => {
      const v = s.expr[gene] ?? -Infinity;
      if (v > bestVal) {
        bestVal = v;
        best = i;
      }
    });
    return best;
  }, [pred, gene]);

  // Runs automatically whenever the upload or the selected gene changes —
  // no manual "Show Grad-CAM" click. seq guards against an older, slower
  // request resolving after a newer one if the gene is switched again
  // before the first call finishes.
  useEffect(() => {
    const seq = ++seqRef.current;
    setImgUrl(null);
    setError("");
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }

    if (!ready || !pred.spots.length) return;
    if (!file) {
      setError("Grad-CAM needs the original uploaded image — re-upload the section (history-loaded predictions don't keep the file)");
      return;
    }

    setLoading(true);
    explainGradcam(file, spotIndex, gene)
      .then((blob) => {
        if (seq !== seqRef.current) return;
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        setImgUrl(url);
      })
      .catch((e) => {
        if (seq !== seqRef.current) return;
        setError(e instanceof Error ? e.message : "Grad-CAM failed");
      })
      .finally(() => {
        if (seq === seqRef.current) setLoading(false);
      });
  }, [file, gene, spotIndex, ready, pred.spots.length]);

  useEffect(() => {
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  if (!ready) {
    return (
      <div className="plot-body gradcam-body">
        <div className="canvas-wrap gradcam-image">
          <div className="canvas-empty">Grad-CAM renders after prediction</div>
        </div>
      </div>
    );
  }

  return (
    <div className="plot-body gradcam-body">
      <div className="gradcam-controls">
        <span className="page-label">
          highest predicted {gene} · tile {spotIndex + 1} of {pred.spots.length}
        </span>
      </div>
      <div className="canvas-wrap gradcam-image">
        {error && <div className="canvas-empty">{error}</div>}
        {!error && loading && <div className="canvas-empty">running Grad-CAM…</div>}
        {!error && !loading && imgUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imgUrl} alt={`Grad-CAM overlay for ${gene}'s top tile`} />
        )}
      </div>
    </div>
  );
}
