"use client";

import { useEffect, useRef, useState } from "react";
import { explainGradcam } from "@/lib/api";
import type { Prediction } from "@/lib/mockPrediction";

export default function GradCamPanel({
  pred,
  ready,
  file,
}: {
  pred: Prediction;
  ready: boolean;
  file: File | null;
}) {
  const [spotIndex, setSpotIndex] = useState(0);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const urlRef = useRef<string | null>(null);

  const maxIndex = Math.max(0, pred.spots.length - 1);

  // A new upload invalidates whatever tile/overlay was showing for the
  // previous one — spot_index is only meaningful for the file it came from.
  useEffect(() => {
    setSpotIndex(0);
    setImgUrl(null);
    setError("");
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, [file]);

  useEffect(() => {
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  async function load() {
    if (!file) {
      setError("Grad-CAM needs the original uploaded image — re-upload the section (history-loaded predictions don't keep the file)");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const blob = await explainGradcam(file, spotIndex);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      setImgUrl(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Grad-CAM failed");
    } finally {
      setLoading(false);
    }
  }

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
        <button
          className="page-btn"
          disabled={spotIndex <= 0}
          onClick={() => setSpotIndex((i) => Math.max(0, i - 1))}
        >
          ← Prev tile
        </button>
        <span className="page-label">
          tile {spotIndex + 1} of {maxIndex + 1}
        </span>
        <button
          className="page-btn"
          disabled={spotIndex >= maxIndex}
          onClick={() => setSpotIndex((i) => Math.min(maxIndex, i + 1))}
        >
          Next tile →
        </button>
        <button className="upload-btn" onClick={load} disabled={loading}>
          {loading ? "Running Grad-CAM…" : "Show Grad-CAM"}
        </button>
      </div>
      <div className="canvas-wrap gradcam-image">
        {error && <div className="canvas-empty">{error}</div>}
        {!error && imgUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imgUrl} alt={`Grad-CAM overlay for tile ${spotIndex}`} />
        )}
        {!error && !imgUrl && !loading && (
          <div className="canvas-empty">pick a tile and click &quot;Show Grad-CAM&quot;</div>
        )}
      </div>
    </div>
  );
}
