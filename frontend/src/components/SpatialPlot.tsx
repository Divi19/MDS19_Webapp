"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CL, viridis, type Prediction, type Spot } from "@/lib/mockPrediction";
import { DEFAULT_TILING, tileCentre, type Tiling } from "@/lib/tiling";
import {
  clusterTissueLabels, formatPercent, isUncertain, TISSUE_CLASSES, TISSUE_COLORS, TISSUE_SHORT_NAMES,
  type TissueClass,
} from "@/lib/tissue";

const MONO = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

// Results pop in rippling out from the tissue centre, once per prediction.
const POP_MS = 700;
const POP_DELAY_PER_PX = 2.4;
const poppedPredictions = new WeakSet<object>();
const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
/** Overshoot ease, the canvas twin of cubic-bezier(.34,1.35,.64,1). */
const popEase = (t: number) => {
  const c = 1.70158 * 0.9;
  const x = Math.min(1, Math.max(0, t)) - 1;
  return 1 + (c + 1) * x * x * x + c * x * x;
};
/** Spot rings: white, strongest around dark spots (purple, dark blue, dark
 * orange) so they stand out from the tissue, and fading towards bright ones
 * (yellow, light green) so those are not haloed and keep their colour. */
const RING_WIDTH = 1.25;
const smoothstep = (lo: number, hi: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};
/** Relative luminance (0 dark to 1 white) of a "#rrggbb" or "rgb(...)" colour. */
const lumCache = new Map<string, number>();
function luminance(color: string): number {
  let lum = lumCache.get(color);
  if (lum !== undefined) return lum;
  const m = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
  const n = color.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  const rgb = m ? m.slice(1, 4).map((h) => parseInt(h, 16)) : n ? n.slice(1, 4).map(Number) : [128, 128, 128];
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  lumCache.set(color, lum);
  return lum;
}
/** How much a colour is at the very bright end (yellow): 0 below
 * yellow-green, 1 at viridis yellow. */
const topBrightness = (color: string) => smoothstep(0.55, 0.78, luminance(color));
function ringFor(color: string): string {
  const lum = luminance(color);
  // 70% for the darkest spots, easing to 25% for the brightest; mid tones
  // (teal, green) keep a clear ring (about 45-60%) so they don't blend into
  // the tissue. The very brightest (yellow, the highest expression) get a
  // little back, up to 45%, so they still catch the eye.
  const alpha = 0.25 + 0.45 * (1 - smoothstep(0.05, 0.75, lum)) + 0.2 * topBrightness(color);
  return `rgba(255,255,255,${alpha.toFixed(2)})`;
}


interface ImgGeom {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  w: number;
  h: number;
}

interface Geom {
  mL: number;
  mT: number;
  pw: number;
  ph: number;
  gk: string;
  /** Present only when the Genes view is overlaying on the real image —
   * the cover-fit source rect needed to place a spot at its true pixel
   * position instead of stretching it across the tissue's bounding box. */
  img?: ImgGeom;
  /** How the prediction's grid indices map to image pixels (lib/tiling.ts). */
  tiling?: Tiling;
}

/** A spot's canvas position — pixel-accurate against the real image when
 * grid indices and an image are available, falling back to the tissue
 * bounding-box normalisation otherwise (dummy/demo data, or no image). */
function spotXY(s: Spot, g: Geom): [number, number] {
  if (g.img && s.gridX != null && s.gridY != null) {
    const [ox, oy] = tileCentre(s.gridX, s.gridY, g.tiling ?? DEFAULT_TILING);
    return [((ox - g.img.sx) / g.img.sw) * g.img.w, ((oy - g.img.sy) / g.img.sh) * g.img.h];
  }
  return [g.mL + s.x * g.pw, g.mT + s.y * g.ph];
}

/** One spot on the Tissue view, in its class colour; tiles whose top
 * probability is below LOW_CONFIDENCE are faded with a dashed outline.
 * `focused` is false for spots outside the legend highlight; they fade,
 * keeping them faintly visible for context. Spots without tissue data are
 * drawn as faint grey. */
function drawTissueSpot(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  r: number,
  s: Spot,
  opacity: number,
  focused: boolean,
) {
  ctx.beginPath();
  ctx.arc(px, py, r, 0, 6.2832);
  if (!s.tissue) {
    ctx.globalAlpha = 0.3 * opacity;
    ctx.fillStyle = "#9a978d";
    ctx.fill();
    ctx.globalAlpha = 1;
    return;
  }
  const fade = focused ? 1 : 0.12;
  const col = TISSUE_COLORS[s.tissue.cls];
  const low = isUncertain(s);
  ctx.globalAlpha = (low ? 0.35 : 1) * opacity * fade;
  ctx.fillStyle = col;
  ctx.fill();
  if (!low) {
    ctx.globalAlpha = fade;
    ctx.lineWidth = RING_WIDTH;
    ctx.strokeStyle = ringFor(col);
    ctx.stroke();
  }
  if (low) {
    ctx.globalAlpha = fade;
    ctx.setLineDash([2, 2]);
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = col;
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.globalAlpha = 1;
}

/** Raw (model-scale) predicted expression, as the Tissue Analysis panel uses. */
function rawExpr(s: Spot, gene: string): number {
  return s.raw?.[gene] ?? s.expr[gene] ?? 0;
}

/** A tile of the pinned tissue type, coloured by the selected gene's level
 * relative to the other tiles of that type (viridis, low -> high). */
function drawGeneSpot(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  r: number,
  t: number,
  opacity: number,
) {
  ctx.beginPath();
  ctx.arc(px, py, r, 0, 6.2832);
  const col = viridis(t);
  ctx.globalAlpha = opacity;
  ctx.fillStyle = col;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.lineWidth = RING_WIDTH;
  ctx.strokeStyle = ringFor(col);
  ctx.stroke();
}

export default function SpatialPlot({
  pred,
  ready,
  view,
  gene,
  imageUrl,
  showImage = true,
  tissuePin = null,
  onTissuePin,
  tissueHover = null,
  clusterPin = null,
  onClusterPin,
  tissueGroupHover = null,
  tissueClusterHover = null,
  tissueClusterPin = null,
}: {
  pred: Prediction;
  ready: boolean;
  view: "clusters" | "genes" | "tissue";
  gene: string;
  imageUrl?: string | null;
  /** Only meaningful in the Genes view overlaying a real image — lets the
   * user strip the tissue background and see just the spatial dot map,
   * with the dots still at their real pixel-accurate positions. */
  showImage?: boolean;
  /** Tissue view: the pinned tissue type (click a legend pill to pin or
   * unpin); everything else fades. Shared with the Tissue Analysis picker. */
  tissuePin?: TissueClass | null;
  onTissuePin?: (cls: TissueClass | null) => void;
  /** Tissue view: a type hovered outside the map (Tissue Analysis rows). */
  tissueHover?: TissueClass | null;
  /** Clusters view: the pinned cluster index (click a legend item or a
   * breakdown tile to pin or unpin); everything else fades. Shared with
   * the Cluster breakdown tiles in GeneXApp. */
  clusterPin?: number | null;
  onClusterPin?: (index: number | null) => void;
  /** Tissue view: one tissue type's tiles within one expression cluster,
   * hovered in Tissue Analysis' expression groups. */
  tissueGroupHover?: { cls: TissueClass; cluster: number } | null;
  /** Tissue view: an expression cluster hovered in Tissue Analysis'
   * Composition tab; only its tiles stay in focus. */
  tissueClusterHover?: number | null;
  /** Tissue view: a cluster locked from the Composition tab (hover wins). */
  tissueClusterPin?: number | null;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const geomRef = useRef<Geom | null>(null);
  // When this prediction's pop-in started; null once it has played (or is skipped).
  const popStartRef = useRef<number | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [highlight, setHighlight] = useState(-1);
  const [width, setWidth] = useState(520);
  const [height, setHeight] = useState(0);
  const [imgTick, setImgTick] = useState(0);
  const [tip, setTip] = useState<{ x: number; y: number; text: string; spot: Spot } | null>(null);
  const [tissueHighlight, setTissueHighlight] = useState<TissueClass | null>(null);
  // Tissue view spot fill opacity, so the H&E underneath stays readable.
  const [spotOpacity, setSpotOpacity] = useState(0.85);
  // The Tissue view only draws tissue when the prediction has it; GeneXApp
  // never offers the tab otherwise.
  const tissueLayer = view === "tissue" && !!pred.tissue;
  // Tissue name per expression cluster ("Cancer (95%)"); all null without
  // tissue data, which leaves the plain cluster names.
  const clusterLabels = useMemo(() => clusterTissueLabels(pred), [pred]);
  // The Clusters legend shows "0 · Cancer" pills unless they would wrap onto
  // more rows than the plain "cluster 0" pills (tissue name then on hover),
  // so the tissue names never push the map smaller than before.
  const clusterLegendRef = useRef<HTMLDivElement>(null);
  const [legendNamed, setLegendNamed] = useState(true);
  // A pinned type stays highlighted, like hovering it. The bottom card's
  // "Tissue | gene" switch can instead colour its tiles by the selected
  // gene's level within that type; the choice belongs to the type it was
  // made for, so pinning another type starts back on Tissue.
  const [geneModeType, setGeneModeType] = useState<TissueClass | null>(null);
  const geneMode = !!tissuePin && geneModeType === tissuePin;
  // The pinned type's range of the selected gene: the colour scale and the
  // legend's min/max in gene mode.
  const pinRange = useMemo(() => {
    if (!tissueLayer || !tissuePin) return null;
    const values = pred.spots.filter((s) => s.tissue?.cls === tissuePin).map((s) => rawExpr(s, gene));
    if (!values.length) return { min: 0, max: 0, count: 0 };
    return { min: Math.min(...values), max: Math.max(...values), count: values.length };
  }, [pred, gene, tissueLayer, tissuePin]);


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

  // Load the uploaded section itself, so the Genes view can overlay
  // predicted expression directly on the real tissue instead of a blank grid.
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
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = width;
    // Fill the flex-allotted wrapper (col-2 must never scroll) but never
    // exceed the natural 4:3-ish aspect ratio when there's room to spare.
    const h = height > 0 ? height : Math.round(w * 0.72);
    cv.width = w * dpr;
    cv.height = h * dpr;
    cv.style.height = `${h}px`;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!ready) {
      geomRef.current = null;
      return;
    }

    const genesView = view === "genes";
    const popStart = popStartRef.current;
    const elapsed = popStart == null ? Infinity : performance.now() - popStart;
    let pcx = w / 2;
    let pcy = h / 2;
    const centreOn = (pts: [number, number][]) => {
      if (elapsed === Infinity || !pts.length) return;
      pcx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
      pcy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    };
    const popOf = (px: number, py: number) =>
      elapsed === Infinity ? 1 : popEase((elapsed - Math.hypot(px - pcx, py - pcy) * POP_DELAY_PER_PX) / POP_MS);
    // Whether a spot passes the current legend highlight.
    // Hovering (legend or analysis panel) previews a type; otherwise the pin holds.
    const focusType = tissueHighlight ?? tissueHover ?? tissuePin;
    // A hovered expression group narrows the focus to one type in one cluster.
    const tissueFocus = (s: Spot) =>
      tissueGroupHover
        ? s.tissue?.cls === tissueGroupHover.cls && s.cluster === tissueGroupHover.cluster
        : (tissueClusterHover ?? tissueClusterPin) != null
          ? s.cluster === (tissueClusterHover ?? tissueClusterPin)
          : focusType == null || s.tissue?.cls === focusType;
    // Gene-within-type colouring while a type is pinned and nothing is being
    // previewed by hover.
    // Another type, group or cluster being previewed takes over the map; a
    // preview of the pinned type itself does not (clicking a legend pill
    // pins it while the pointer is still on it).
    const previewing =
      (tissueHighlight != null && tissueHighlight !== tissuePin) ||
      (tissueHover != null && tissueHover !== tissuePin) ||
      tissueGroupHover != null ||
      tissueClusterHover != null ||
      tissueClusterPin != null;
    const geneInPin = geneMode && pinRange && pinRange.count && !previewing ? pinRange : null;
    const drawTissue = (px: number, py: number, r: number, s: Spot) => {
      if (geneInPin && s.tissue?.cls === tissuePin) {
        const span = geneInPin.max - geneInPin.min;
        drawGeneSpot(ctx, px, py, r, span > 0 ? (rawExpr(s, gene) - geneInPin.min) / span : 0.5, spotOpacity);
      } else {
        drawTissueSpot(ctx, px, py, r, s, spotOpacity, tissueFocus(s));
      }
    };
    let gk = gene;
    if (!pred.geneMeta[gk]) gk = pred.genes[0] ?? "";

    // Genes view with a real section loaded: overlay predicted expression
    // directly on the tissue instead of an abstract grid.
    if ((genesView || tissueLayer) && imgRef.current) {
      const img = imgRef.current;
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
      if (showImage) {
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
      } else {
        ctx.fillStyle = "#faf8f3";
        ctx.fillRect(0, 0, w, h);
      }

      const geom: Geom = { mL: 0, mT: 0, pw: w, ph: h, gk, img: { sx, sy, sw, sh, w, h }, tiling: pred.tiling };
      geomRef.current = geom;

      const r = Math.max(2.4, w / 130);
      centreOn(pred.spots.map((s) => spotXY(s, geom)));
      if (tissueLayer) {
        for (const s of pred.spots) {
          const [px, py] = spotXY(s, geom);
          const k = popOf(px, py);
          if (k > 0.02) drawTissue(px, py, r * k, s);
        }
        return;
      }
      ctx.lineWidth = RING_WIDTH;
      for (const s of pred.spots) {
        const [px, py] = spotXY(s, geom);
        const k = popOf(px, py);
        if (k <= 0.02) continue;
        const col = viridis(s.expr[gk] ?? 0);
        ctx.beginPath();
        ctx.arc(px, py, r * k, 0, 6.2832);
        // Yellow is drawn more solidly so the pink tissue doesn't wash it out.
        ctx.globalAlpha = 0.72 + 0.16 * topBrightness(col);
        ctx.fillStyle = col;
        ctx.fill();
        // The ring is drawn solid so its strength is set by ringFor alone.
        ctx.globalAlpha = 1;
        ctx.strokeStyle = ringFor(col);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      return;
    }

    const mL = 34;
    const mB = 24;
    const mT = 10;
    const mR = 10;
    const pw = w - mL - mR;
    const ph = h - mT - mB;

    ctx.strokeStyle = "#efeae0";
    ctx.lineWidth = 1;
    for (let i = 1; i < 10; i++) {
      const x = mL + (i / 10) * pw;
      ctx.beginPath();
      ctx.moveTo(x, mT);
      ctx.lineTo(x, mT + ph);
      ctx.stroke();
    }
    for (let i = 1; i < 8; i++) {
      const y = mT + (i / 8) * ph;
      ctx.beginPath();
      ctx.moveTo(mL, y);
      ctx.lineTo(mL + pw, y);
      ctx.stroke();
    }
    ctx.strokeStyle = "#c4bba8";
    ctx.beginPath();
    ctx.moveTo(mL, mT);
    ctx.lineTo(mL, mT + ph);
    ctx.lineTo(mL + pw, mT + ph);
    ctx.stroke();

    ctx.fillStyle = "#9a978d";
    ctx.font = `9px ${MONO}`;
    ctx.textAlign = "center";
    ctx.fillText("spatial1", mL + pw / 2, h - 6);
    ctx.save();
    ctx.translate(11, mT + ph / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("spatial2", 0, 0);
    ctx.restore();

    const r = Math.max(2.6, pw / 160);
    centreOn(pred.spots.map((s) => [mL + s.x * pw, mT + s.y * ph]));
    for (const s of pred.spots) {
      const px = mL + s.x * pw;
      const py = mT + s.y * ph;
      const k = popOf(px, py);
      if (k <= 0.02) continue;
      if (tissueLayer) {
        drawTissue(px, py, r * k, s);
        continue;
      }
      ctx.beginPath();
      ctx.arc(px, py, r * k, 0, 6.2832);
      const col = genesView ? viridis(s.expr[gk] ?? 0) : CL[s.cluster];
      // A pin (click) takes priority over a hover preview — clicking a
      // legend item or breakdown tile locks the fade in place so it
      // survives the mouse moving away, instead of only showing on hover.
      const activeCluster = clusterPin ?? (highlight >= 0 ? highlight : null);
      ctx.fillStyle =
        !genesView && activeCluster !== null && s.cluster !== activeCluster ? `${col}20` : col;
      ctx.fill();
      ctx.lineWidth = RING_WIDTH;
      ctx.strokeStyle = ringFor(col);
      ctx.stroke();
    }
    geomRef.current = { mL, mT, pw, ph, gk };
  }, [pred, ready, view, gene, highlight, clusterPin, width, height, imgTick, imageUrl, showImage, tissueLayer, tissueHighlight, tissueHover, tissueGroupHover, tissueClusterHover, tissueClusterPin, tissuePin, pinRange, spotOpacity, geneMode]);

  useEffect(() => {
    draw();
  }, [draw]);

  // Pop-in: replay the draw each frame for a couple of seconds the first time
  // this prediction is shown. The latest draw is read through a ref so a hover
  // or resize mid-animation doesn't restart it.
  const drawRef = useRef(draw);
  useEffect(() => {
    drawRef.current = draw;
  }, [draw]);
  useEffect(() => {
    if (!ready || !pred.spots.length || poppedPredictions.has(pred) || prefersReducedMotion()) {
      popStartRef.current = null;
      return;
    }
    const start = performance.now();
    popStartRef.current = start;
    let raf = 0;
    const tick = () => {
      drawRef.current();
      if (performance.now() - start < 2400) {
        raf = requestAnimationFrame(tick);
      } else {
        poppedPredictions.add(pred);
        popStartRef.current = null;
        drawRef.current();
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      popStartRef.current = null;
    };
  }, [ready, pred]);

  // Named pills unless they would take more rows than the plain ones
  // (measured on the invisible copies, again on every resize).
  useLayoutEffect(() => {
    const wrap = clusterLegendRef.current;
    if (!wrap) return;
    const rows = (el: Element) => new Set([...el.children].map((c) => (c as HTMLElement).offsetTop)).size;
    const ro = new ResizeObserver(() => {
      const [named, plain] = wrap.querySelectorAll(".legend-sizer");
      if (named && plain) setLegendNamed(rows(named) <= rows(plain));
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [clusterLabels, ready, view]);

  const clusterPillText = (i: number, named: boolean) =>
    named && clusterLabels[i] ? (
      <span className="legend-name">
        {i}
        <span className="legend-tissue"> · {clusterLabels[i]!.short}</span>
      </span>
    ) : (
      <span className="legend-name">{pred.clusters[i]?.name ?? `cluster ${i}`}</span>
    );

  function handleMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const g = geomRef.current;
    const cv = canvasRef.current;
    if (!g || !cv) return;
    const rect = cv.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best: { s: Spot; px: number; py: number } | null = null;
    let bd = 1e9;
    for (const s of pred.spots) {
      const [px, py] = spotXY(s, g);
      const d = (mx - px) ** 2 + (my - py) ** 2;
      if (d < bd) {
        bd = d;
        best = { s, px, py };
      }
    }
    if (best && bd < 200) {
      const text =
        view === "genes"
          ? `${pred.geneMeta[g.gk]?.label ?? g.gk} ${(best.s.expr[g.gk] ?? 0).toFixed(2)} · cluster ${best.s.cluster}`
          : view === "tissue"
          ? // Raw predicted expression, the same scale as the Tissue Analysis panel.
            `${pred.geneMeta[g.gk]?.label ?? g.gk} ${rawExpr(best.s, g.gk).toFixed(2)} · cluster ${best.s.cluster}`
          : `${pred.clusters[best.s.cluster]?.name ?? `cluster ${best.s.cluster}`}${
              clusterLabels[best.s.cluster] ? ` · ${clusterLabels[best.s.cluster]!.full}` : ""
            }`;
      setTip({ x: best.px, y: best.py, text, spot: best.s });
    } else {
      setTip(null);
    }
  }

  return (
    <div className="plot-body">
      <div className="canvas-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          width={520}
          height={380}
          onMouseMove={handleMove}
          onMouseLeave={() => setTip(null)}
        />
        {!ready && <div className="canvas-empty">spatial map renders after prediction</div>}
        <div
          className={`plot-tip glass-lite${tissueLayer && tip?.spot.tissue ? " plot-tip-tissue" : ""}${tip && tip.x > width / 2 ? " flip" : ""}`}
          style={{ opacity: tip ? 1 : 0, left: tip?.x ?? 0, top: tip?.y ?? 0 }}
        >
          {tip?.text}
          {tissueLayer && tip?.spot.tissue && (
            <div className="tip-tissue">
              <div className="tip-tissue-head">
                <span className="legend-dot" style={{ background: TISSUE_COLORS[tip.spot.tissue.cls] }} />
                {tip.spot.tissue.cls} · {formatPercent(tip.spot.tissue.confidence)}
                {isUncertain(tip.spot) && <span className="tip-low" title="Top class probability below 50%">uncertain</span>}
              </div>
              {TISSUE_CLASSES.map((name) => (
                <div key={name} className="tip-prob">
                  <span className="tip-prob-name">{name}</span>
                  <span className="tip-prob-bar">
                    <span style={{ width: `${tip.spot.tissue!.probs[name] * 100}%`, background: TISSUE_COLORS[name] }} />
                  </span>
                  <span className="tip-prob-val">{tip.spot.tissue!.probs[name].toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="dock glass">
        {ready && view === "clusters" && (
          <div className="legend-wrap" ref={clusterLegendRef}>
            <div className="legend">
              {CL.map((c, i) => (
                <div
                  key={i}
                  className={`legend-item${legendNamed && clusterLabels[i] ? " legend-item-tissue" : ""}${clusterPin === i ? " pinned" : ""}`}
                  onMouseEnter={() => setHighlight(i)}
                  onMouseLeave={() => setHighlight(-1)}
                  onClick={() => onClusterPin?.(clusterPin === i ? null : i)}
                  title={clusterLabels[i] ? `${pred.clusters[i]?.name ?? `cluster ${i}`} · ${clusterLabels[i]!.full}` : undefined}
                >
                  <span className="legend-dot" style={{ background: c }} />
                  {clusterPillText(i, legendNamed)}
                </div>
              ))}
            </div>
            {/* Invisible copies of the legend with and without tissue names, at
                the same width, to count how many rows each would take. */}
            {clusterLabels.some((l) => l) &&
              [true, false].map((named) => (
                <div key={String(named)} className="legend legend-sizer" aria-hidden>
                  {CL.map((c, i) => (
                    <div key={i} className={`legend-item${named && clusterLabels[i] ? " legend-item-tissue" : ""}`}>
                      <span className="legend-dot" />
                      {clusterPillText(i, named)}
                    </div>
                  ))}
                </div>
              ))}
          </div>
        )}

        {ready && tissueLayer && pred.tissue && (
          // Built from the same .legend/.vbar/.vscale elements as the Genes
          // colour bar (kept invisible), so this slot, and therefore the map
          // above it, is exactly the same height as on the Genes tab. The class
          // legend and opacity slider sit on top of it.
          <div className="tissue-legend-slot">
            <div className="legend" aria-hidden>
              <div className="vbar is-hidden" />
            </div>
            <div className="vscale is-hidden" aria-hidden>
              <span>&nbsp;</span>
            </div>
            <div className="tissue-legend-row">
              {tissuePin && pinRange ? (
                <div className="tissue-gene-scale">
                  <button
                    type="button"
                    className="legend-item legend-compact pinned"
                    aria-pressed
                    aria-label={`Unpin ${tissuePin}`}
                    title={`${tissuePin} pinned · click to unpin`}
                    onClick={() => onTissuePin?.(null)}
                  >
                    <span className="legend-dot" style={{ background: TISSUE_COLORS[tissuePin] }} />
                    {TISSUE_SHORT_NAMES[tissuePin]}
                    <span aria-hidden className="unpin">×</span>
                  </button>
                  <div
                    className="seg colour-by"
                    role="group"
                    aria-label={`Colour ${TISSUE_SHORT_NAMES[tissuePin]} tiles by`}
                    title={`Colour the ${TISSUE_SHORT_NAMES[tissuePin]} tiles by tissue type or by ${gene}`}
                  >
                    <button
                      type="button"
                      className={geneMode ? "" : "on"}
                      aria-pressed={!geneMode}
                      onClick={() => setGeneModeType(null)}
                    >
                      Tissue
                    </button>
                    <button
                      type="button"
                      className={geneMode ? "on" : ""}
                      aria-pressed={geneMode}
                      onClick={() => setGeneModeType(tissuePin)}
                    >
                      {gene}
                    </button>
                  </div>
                  {geneMode &&
                    (pinRange.count ? (
                      <span
                        className="tgs"
                        title={`${gene} in ${tissuePin} tiles, scaled from the lowest to the highest of those tiles`}
                      >
                        <span className="tgs-val">{pinRange.min.toFixed(2)}</span>
                        <span className="vbar tgs-bar" />
                        <span className="tgs-val">{pinRange.max.toFixed(2)}</span>
                      </span>
                    ) : (
                      <span className="tgs tgs-empty">no {TISSUE_SHORT_NAMES[tissuePin]} tiles</span>
                    ))}
                </div>
              ) : (
                <div className="tissue-legend" aria-label="Tissue type legend">
                  {TISSUE_CLASSES.map((name) => {
                    const { count, fraction } = pred.tissue!.summary[name];
                    const label = `${name} ${count} · ${formatPercent(fraction)}`;
                    return (
                      <button
                        key={name}
                        type="button"
                        aria-label={label}
                        title={`${label} · click to ${tissuePin === name ? "unpin" : "pin"}`}
                        className={`legend-item legend-compact${tissuePin === name ? " pinned" : ""}`}
                        aria-pressed={tissuePin === name}
                        onClick={() => {
                          // The pill is replaced by the pinned controls, so its
                          // mouse-leave never fires: drop the preview here.
                          setTissueHighlight(null);
                          onTissuePin?.(tissuePin === name ? null : name);
                        }}
                        onMouseEnter={() => setTissueHighlight(name)}
                        onMouseLeave={() => setTissueHighlight(null)}
                        onFocus={() => setTissueHighlight(name)}
                        onBlur={() => setTissueHighlight(null)}
                      >
                        <span className="legend-dot" style={{ background: TISSUE_COLORS[name] }} />
                        {TISSUE_SHORT_NAMES[name]}
                      </button>
                    );
                  })}
                </div>
              )}
              <label className="opacity-control">
                Opacity
                <input
                  type="range"
                  min={0.15}
                  max={1}
                  step={0.05}
                  value={spotOpacity}
                  onChange={(e) => setSpotOpacity(Number(e.target.value))}
                  aria-label="Spot opacity"
                />
              </label>
            </div>
          </div>
        )}

        {ready && view === "genes" && (
          <>
            <div className="legend">
              <div className="vbar" />
            </div>
            <div className="vscale">
              <span>low</span>
              <span>predicted expression</span>
              <span>high</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
