"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CL, viridis, type Prediction, type Spot } from "@/lib/mockPrediction";

const MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

interface Geom {
  mL: number;
  mT: number;
  pw: number;
  ph: number;
  gk: string;
}

export default function SpatialPlot({
  pred,
  ready,
  view,
  gene,
}: {
  pred: Prediction;
  ready: boolean;
  view: "clusters" | "genes";
  gene: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const geomRef = useRef<Geom | null>(null);
  const [highlight, setHighlight] = useState(-1);
  const [width, setWidth] = useState(520);
  const [height, setHeight] = useState(0);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);

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

    const genesView = view === "genes";
    let gk = gene;
    if (!pred.geneMeta[gk]) gk = pred.genes[0] ?? "";
    const r = Math.max(2.6, pw / 160);
    for (const s of pred.spots) {
      const px = mL + s.x * pw;
      const py = mT + s.y * ph;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, 6.2832);
      const col = genesView ? viridis(s.expr[gk] ?? 0) : CL[s.cluster];
      ctx.fillStyle =
        !genesView && highlight >= 0 && s.cluster !== highlight ? `${col}20` : col;
      ctx.fill();
    }
    geomRef.current = { mL, mT, pw, ph, gk };
  }, [pred, ready, view, gene, highlight, width, height]);

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
      const px = g.mL + s.x * g.pw;
      const py = g.mT + s.y * g.ph;
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
          : (pred.clusters[best.s.cluster]?.name ?? `cluster ${best.s.cluster}`);
      setTip({ x: best.px, y: best.py, text });
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
          className="plot-tip"
          style={{ opacity: tip ? 1 : 0, left: tip?.x ?? 0, top: tip?.y ?? 0 }}
        >
          {tip?.text}
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
