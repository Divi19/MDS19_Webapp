"use client";

import { useEffect, useRef } from "react";
import type { Prediction } from "@/lib/mockPrediction";
import { DEFAULT_TILING, drawImageRect, tissueViewRect } from "@/lib/tiling";

/** The Input section thumbnail: the uploaded slide cropped so the tissue is
 * centred and fills the frame (same view as the spatial map — see
 * tissueViewRect), instead of a plain centre crop of the whole upload. Fills
 * its parent, whatever size CSS gives it. */
export default function TissueThumb({
  url,
  pred,
  alt,
}: {
  url: string;
  pred: Prediction;
  alt: string;
}) {
  const cvRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = cvRef.current;
    const box = cv?.parentElement;
    if (!cv || !box) return;
    let alive = true;
    const img = new Image();

    const draw = () => {
      const w = box.clientWidth;
      const h = box.clientHeight;
      if (!img.complete || !img.naturalWidth || w <= 0 || h <= 0) return;
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const rect = tissueViewRect(img.naturalWidth, img.naturalHeight, pred.spots, pred.tiling ?? DEFAULT_TILING, w, h);
      drawImageRect(ctx, img, rect, w, h);
    };

    img.onload = () => alive && draw();
    img.src = url;
    const ro = new ResizeObserver(draw);
    ro.observe(box);
    return () => {
      alive = false;
      ro.disconnect();
    };
  }, [url, pred]);

  return <canvas ref={cvRef} role="img" aria-label={alt} />;
}
