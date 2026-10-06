"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CL, viridis, type Prediction, type Spot } from "@/lib/mockPrediction";
import {
  formatPercent, isUncertain, TISSUE_CLASSES, TISSUE_COLORS, TISSUE_SHORT_NAMES,
  type TissueClass,
} from "@/lib/tissue";

const MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

// Fixed by the model's training config (see predictor.py) — not tunable
// here, just mirrored so the overlay can convert a tile's grid index back
// into a pixel position on the original upload.
const PATCH = 224;
const STRIDE = 224;

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
}

/** A spot's canvas position — pixel-accurate against the real image when
 * grid indices and an image are available, falling back to the tissue
 * bounding-box normalisation otherwise (dummy/demo data, or no image). */
function spotXY(s: Spot, g: Geom): [number, number] {
  if (g.img && s.gridX != null && s.gridY != null) {
    const ox = s.gridX * STRIDE + PATCH / 2;
    const oy = s.gridY * STRIDE + PATCH / 2;
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

export default function SpatialPlot({
  pred,
  ready,
  view,
  gene,
  imageUrl,
  showImage = true,
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
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const geomRef = useRef<Geom | null>(null);
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
    const h = height > 0 ? Math.min(Math.round(w * 0.72), height) : Math.round(w * 0.72);
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
    // Whether a spot passes the current legend highlight.
    const tissueFocus = (s: Spot) => tissueHighlight == null || s.tissue?.cls === tissueHighlight;
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

      const geom: Geom = { mL: 0, mT: 0, pw: w, ph: h, gk, img: { sx, sy, sw, sh, w, h } };
      geomRef.current = geom;

      const r = Math.max(2.4, w / 130);
      if (tissueLayer) {
        for (const s of pred.spots) {
          const [px, py] = spotXY(s, geom);
          drawTissueSpot(ctx, px, py, r, s, spotOpacity, tissueFocus(s));
        }
        return;
      }
      ctx.globalAlpha = 0.72;
      for (const s of pred.spots) {
        const [px, py] = spotXY(s, geom);
        ctx.beginPath();
        ctx.arc(px, py, r, 0, 6.2832);
        ctx.fillStyle = viridis(s.expr[gk] ?? 0);
        ctx.fill();
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
    for (const s of pred.spots) {
      const px = mL + s.x * pw;
      const py = mT + s.y * ph;
      if (tissueLayer) {
        drawTissueSpot(ctx, px, py, r, s, spotOpacity, tissueFocus(s));
        continue;
      }
      ctx.beginPath();
      ctx.arc(px, py, r, 0, 6.2832);
      const col = genesView ? viridis(s.expr[gk] ?? 0) : CL[s.cluster];
      ctx.fillStyle =
        !genesView && highlight >= 0 && s.cluster !== highlight ? `${col}20` : col;
      ctx.fill();
    }
    geomRef.current = { mL, mT, pw, ph, gk };
  }, [pred, ready, view, gene, highlight, width, height, imgTick, imageUrl, showImage, tissueLayer, tissueHighlight, spotOpacity]);

  useEffect(() => {
    draw();
  }, [draw]);

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
        view === "genes" || view === "tissue"
          ? `${pred.geneMeta[g.gk]?.label ?? g.gk} ${(best.s.expr[g.gk] ?? 0).toFixed(2)} · cluster ${best.s.cluster}`
          : (pred.clusters[best.s.cluster]?.name ?? `cluster ${best.s.cluster}`);
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
          className={`plot-tip${tissueLayer && tip?.spot.tissue ? " plot-tip-tissue" : ""}`}
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

      {ready && view === "clusters" && (
        <div className="legend">
          {CL.map((c, i) => (
            <div
              key={i}
              className="legend-item"
              onMouseEnter={() => setHighlight(i)}
              onMouseLeave={() => setHighlight(-1)}
            >
              <span className="legend-dot" style={{ background: c }} />
              <span>
                {pred.clusters[i]?.name ?? `cluster ${i}`}
              </span>
              <span className="legend-count">{pred.counts[i]}</span>
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
            <div className="tissue-legend" aria-label="Tissue type legend">
              {TISSUE_CLASSES.map((name) => {
                const { count, fraction } = pred.tissue!.summary[name];
                const label = `${name} ${count} · ${formatPercent(fraction)}`;
                return (
                  <button
                    key={name}
                    type="button"
                    className="legend-item legend-compact"
                    aria-label={label}
                    title={label}
                    aria-pressed={tissueHighlight === name}
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
  );
}
