"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Prediction, Spot } from "@/lib/mockPrediction";
import { DEFAULT_TILING, tileCentre, type Tiling } from "@/lib/tiling";


// Low-res field the heatmap is computed on, then smoothly upscaled onto the
// real canvas — cheap (tens of thousands of cells, not one per screen pixel)
// and the browser's own bilinear image scaling gives the smooth/organic look.
// 90 looked low-poly/faceted on a real slide with hundreds of spots — the
// tissue silhouette needs enough cells to actually curve.
const FIELD_W = 200;

interface ImgGeom {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  w: number;
  h: number;
}

function spotXY(s: Spot, g: ImgGeom, tiling: Tiling): [number, number] {
  const [ox, oy] = tileCentre(s.gridX ?? 0, s.gridY ?? 0, tiling);
  return [((ox - g.sx) / g.sw) * g.w, ((oy - g.sy) / g.sh) * g.h];
}

/** Same jet-style approximation the original Grad-CAM overlay used
 * (backend/app/services/gradcam.py's _jet()) — dark blue at low, dark red
 * at high. Ported so this tab's colors match what "Grad-CAM" looked like
 * before, even though it's now expression, not gradient attribution. */
function jetRGB(t: number): [number, number, number] {
  const r = Math.min(1, Math.max(0, 1.5 - Math.abs(4 * t - 3)));
  const g = Math.min(1, Math.max(0, 1.5 - Math.abs(4 * t - 2)));
  const b = Math.min(1, Math.max(0, 1.5 - Math.abs(4 * t - 1)));
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

export default function ExpressionHeatmap({
  pred,
  ready,
  gene,
  imageUrl,
}: {
  pred: Prediction;
  ready: boolean;
  gene: string;
  imageUrl?: string | null;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fieldCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [width, setWidth] = useState(520);
  const [height, setHeight] = useState(0);
  const [imgTick, setImgTick] = useState(0);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      setWidth(el.clientWidth || 520);
      setHeight(el.clientHeight || 0);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!imageUrl) {
      imgRef.current = null;
      return;
    }
    let cancelled = false;
    const img = new window.Image();
    img.onload = () => {
      if (cancelled) return;
      imgRef.current = img;
      setImgTick((t) => t + 1);
    };
    img.src = imageUrl;
    return () => {
      cancelled = true;
    };
  }, [imageUrl]);

  const draw = useCallback(() => {
    const cv = canvasRef.current;
    const img = imgRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = width;
    const h = height > 0 ? Math.min(Math.round(w * 0.72), height) : Math.round(w * 0.72);
    cv.width = w * dpr;
    cv.height = h * dpr;
    cv.style.height = `${h}px`;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!img || !ready) return;

    // Cover-fit the real image into the canvas — same transform SpatialPlot
    // uses for its image-overlay view, so tile positions line up identically.
    const ir = img.naturalWidth / img.naturalHeight;
    const cr = w / h;
    let sx: number, sy: number, sw: number, sh: number;
    if (ir > cr) {
      sh = img.naturalHeight;
      sw = sh * cr;
      sy = 0;
      sx = (img.naturalWidth - sw) / 2;
    } else {
      sw = img.naturalWidth;
      sh = sw / cr;
      sx = 0;
      sy = (img.naturalHeight - sh) / 2;
    }
    const geom: ImgGeom = { sx, sy, sw, sh, w, h };
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);

    const spots = pred.spots.filter((s) => s.gridX != null && s.gridY != null);
    if (!spots.length || !pred.geneMeta[gene]) return;

    const points = spots.map((s) => {
      const [x, y] = spotXY(s, geom, tiling);
      return { x, y, v: s.expr[gene] ?? 0 };
    });

    // Nearest-neighbour spacing in canvas pixels, derived analytically from
    // the tile stride rather than sampled — used to decide how far the
    // heatmap may spread past a spot before leaving it uncoloured (so it
    // hugs the tissue's real footprint instead of bleeding into background).
    // Fades out over a range (innerD2..outerD2) instead of a hard cutoff —
    // a binary on/off coverage test upscaled from a low-res grid produces a
    // faceted, low-poly-looking edge; a gradual ramp upscales into a smooth
    // curve that actually follows the tissue's real (irregular) boundary.
    const tiling = pred.tiling ?? DEFAULT_TILING;
    const spacing = tiling.stride * (geom.w / geom.sw);
    const innerD2 = (spacing * 0.9) ** 2;
    const outerD2 = (spacing * 1.7) ** 2;
    // Half a spot-spacing — big enough that adjacent spots blend smoothly
    // into each other, small enough that real spatial structure survives.
    const idwEps = (spacing * 0.5) ** 2;

    const fieldH = Math.max(1, Math.round((FIELD_W * h) / w));
    if (!fieldCanvasRef.current) fieldCanvasRef.current = document.createElement("canvas");
    const fc = fieldCanvasRef.current;
    fc.width = FIELD_W;
    fc.height = fieldH;
    const fctx = fc.getContext("2d")!;
    const image = fctx.createImageData(FIELD_W, fieldH);

    for (let fy = 0; fy < fieldH; fy++) {
      const cy = ((fy + 0.5) / fieldH) * h;
      for (let fx = 0; fx < FIELD_W; fx++) {
        const cx = ((fx + 0.5) / FIELD_W) * w;
        let bestD2 = Infinity;
        let wSum = 0;
        let vSum = 0;
        for (const p of points) {
          const d2 = (cx - p.x) ** 2 + (cy - p.y) ** 2;
          if (d2 < bestD2) bestD2 = d2;
          // Epsilon scaled to the actual spot spacing, not a flat "+1" — a
          // flat epsilon is negligible next to real pixel-scale distances,
          // so every spot dominated only its own exact location and showed
          // up as an isolated glowing dot instead of blending with its
          // neighbours into one continuous field.
          const wgt = 1 / (d2 + idwEps);
          wSum += wgt;
          vSum += wgt * p.v;
        }
        const idx = (fy * FIELD_W + fx) * 4;
        if (bestD2 >= outerD2 || wSum === 0) {
          image.data[idx + 3] = 0; // outside coverage — transparent, real tissue shows through
          continue;
        }
        // Smoothstep ease from full strength at innerD2 down to 0 at outerD2.
        const t = bestD2 <= innerD2 ? 1 : 1 - (bestD2 - innerD2) / (outerD2 - innerD2);
        const fade = t * t * (3 - 2 * t);
        const [r, g, b] = jetRGB(vSum / wSum);
        image.data[idx] = r;
        image.data[idx + 1] = g;
        image.data[idx + 2] = b;
        // 0.4 — matches the original Grad-CAM overlay's alpha, so tissue
        // texture stays visible underneath instead of being painted over.
        image.data[idx + 3] = Math.round(0.4 * fade * 255);
      }
    }
    fctx.putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(fc, 0, 0, FIELD_W, fieldH, 0, 0, w, h);
  }, [pred, ready, gene, width, height]);

  useEffect(() => {
    draw();
  }, [draw, imgTick]);

  return (
    <div className="plot-body">
      <div className="canvas-wrap" ref={wrapRef}>
        <canvas ref={canvasRef} width={520} height={380} />
        {!ready && <div className="canvas-empty">heatmap renders after prediction</div>}
      </div>
      {ready && (
        <>
          <div className="legend">
            <div className="vbar vbar-jet" />
          </div>
          <div className="vscale">
            <span>low</span>
            <span>predicted expression</span>
            <span>high</span>
          </div>
        </>
      )}
    </div>
  );
}
