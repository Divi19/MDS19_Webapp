"use client";

import { useEffect, useRef } from "react";
import type { Prediction } from "@/lib/mockPrediction";
import { DEFAULT_TILING, drawImageRect, tissueViewRect, viewRectForBox, type ViewRect } from "@/lib/tiling";
import { detectTissueBox, type Box } from "@/lib/tissueBox";

/** A thumbnail of the uploaded slide cropped so the tissue is centred and
 * fills the frame (same view as the spatial map — see tissueViewRect),
 * instead of a plain centre crop of the whole upload. With a prediction the
 * tissue is where its tiles are; without one (the landing-page preview, before
 * anything has run) it is found from the image itself. Fills its parent,
 * whatever size CSS gives it. */
export default function TissueThumb({
  url,
  pred,
  alt,
}: {
  url: string;
  pred?: Prediction;
  alt: string;
}) {
  const cvRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = cvRef.current;
    const box = cv?.parentElement;
    if (!cv || !box) return;
    let alive = true;
    const img = new Image();
    // Found once per image when there is no prediction to say where the tissue is.
    let detected: Box | null = null;

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
      const iw = img.naturalWidth;
      const ih = img.naturalHeight;
      const rect: ViewRect = pred
        ? tissueViewRect(iw, ih, pred.spots, pred.tiling ?? DEFAULT_TILING, w, h)
        : viewRectForBox(iw, ih, detected ?? { x0: 0, y0: 0, x1: iw, y1: ih }, w, h);
      drawImageRect(ctx, img, rect, w, h);
    };

    img.onload = () => {
      if (!alive) return;
      if (!pred) detected = detectTissueBox(img);
      draw();
    };
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
