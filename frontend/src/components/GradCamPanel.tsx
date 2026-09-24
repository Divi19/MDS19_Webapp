"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { explainGradcamBatch } from "@/lib/api";
import type { Prediction, Spot } from "@/lib/mockPrediction";

// Fixed by the model's training config (see predictor.py) — mirrors the same
// constants SpatialPlot.tsx uses to place a spot at its true pixel position.
const PATCH = 224;
const STRIDE = 224;

// How many tiles go in one /gradcam/batch request — one forward/backward
// pass covers the whole group, instead of paying the encoder's per-call
// overhead once per tile. Keep roughly matched to the backend's own
// encode BATCH_SIZE (predictor.py) — no hard coupling, just a shared
// assumption about a sane batch size for this model on a CPU host.
const REQUEST_BATCH_SIZE = 16;

// How far a wheel tick (or the +/- buttons) may zoom in, and the minimum
// (fit-to-view) scale.
const MAX_SCALE = 8;
const MIN_SCALE = 1;
const ZOOM_STEP = 1.4;

// A spot's opacity is scaled by its raw peak relative to PEAK_PERCENTILE of
// all loaded spots' peaks — the 90th percentile rather than the literal
// max, so one unusually strong outlier spot doesn't single-handedly crush
// every other spot's opacity toward invisible. MIN_OPACITY floors how dim
// the weakest spot can go, so a genuinely weak-but-real signal stays
// perceptible instead of fading to nothing.
const PEAK_PERCENTILE = 0.9;
const MIN_OPACITY = 0.35;

interface ImgGeom {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  w: number;
  h: number;
}

interface ViewState {
  scale: number;
  panX: number;
  panY: number;
}

function computeGeom(img: HTMLImageElement, w: number, h: number): ImgGeom {
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
  return { sx, sy, sw, sh, w, h };
}

/** A tile's bounding box on the canvas, from its true grid position on the
 * real image — same cover-fit transform SpatialPlot.tsx uses. Position
 * steps by STRIDE (tile spacing); size is the patch's own footprint
 * (PATCH) — equal by the model's config (non-overlapping tiles), but
 * kept as separate constants for what each one actually means. */
function tileRect(s: Spot, g: ImgGeom) {
  const ox = (s.gridX ?? 0) * STRIDE;
  const oy = (s.gridY ?? 0) * STRIDE;
  const x = ((ox - g.sx) / g.sw) * g.w;
  const y = ((oy - g.sy) / g.sh) * g.h;
  const w = (PATCH / g.sw) * g.w;
  const h = (PATCH / g.sh) * g.h;
  return { x, y, w, h };
}

function clampPan(view: ViewState, w: number, h: number) {
  const minX = w * (1 - view.scale);
  const minY = h * (1 - view.scale);
  view.panX = Math.min(0, Math.max(minX, view.panX));
  view.panY = Math.min(0, Math.max(minY, view.panY));
}

function base64ToBlob(b64: string, type = "image/png"): Blob {
  const bytes = atob(b64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type });
}

function loadTileImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("tile image failed to decode"));
    };
    img.src = url;
  });
}

export default function GradCamPanel({
  pred,
  ready,
  file,
  imageUrl,
  hidden,
}: {
  pred: Prediction;
  ready: boolean;
  file: File | null;
  imageUrl?: string | null;
  // Visually hides the panel without unmounting it — the loading effect
  // keeps running and already-loaded tiles stay in memory while another
  // tab is showing, instead of losing all progress on every tab switch.
  hidden?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const detailCanvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const seqRef = useRef(0);
  const tileImgsRef = useRef<(HTMLImageElement | null)[]>([]);
  // Each spot's overlay is already colour-normalised to its own peak (see
  // gradcam.py), so raw colour can't be compared spot-to-spot — peaksRef
  // holds each one's true pre-normalisation strength, so draw() can scale
  // each spot's opacity by how strong it really is relative to the rest
  // of the slide, instead of every spot looking equally "hot".
  const peaksRef = useRef<number[]>([]);
  const viewRef = useRef<ViewState>({ scale: 1, panX: 0, panY: 0 });
  const dragRef = useRef<{ moved: boolean; lastX: number; lastY: number } | null>(null);

  const [width, setWidth] = useState(520);
  const [height, setHeight] = useState(0);
  const [imgTick, setImgTick] = useState(0);
  const [loadedCount, setLoadedCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedTile, setSelectedTile] = useState<number | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const [dragging, setDragging] = useState(false);

  const total = pred.spots.length;
  const pct = total ? Math.round((loadedCount / total) * 100) : 0;

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
    const view = viewRef.current;
    ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.panX, dpr * view.panY);
    ctx.clearRect(-view.panX / view.scale, -view.panY / view.scale, w / view.scale, h / view.scale);
    if (!img) return;

    const geom = computeGeom(img, w, h);
    ctx.drawImage(img, geom.sx, geom.sy, geom.sw, geom.sh, 0, 0, w, h);

    // Reference scale for opacity: the 90th-percentile peak among loaded
    // spots, not the literal max — one unusually strong outlier spot
    // shouldn't single-handedly crush every other spot's opacity toward
    // invisible. Recomputed fresh each draw (cheap — a few hundred numbers
    // at most) so it keeps adjusting as more spots load in.
    const loadedPeaks: number[] = [];
    for (let i = 0; i < pred.spots.length; i++) {
      if (tileImgsRef.current[i]) loadedPeaks.push(peaksRef.current[i] ?? 0);
    }
    loadedPeaks.sort((a, b) => a - b);
    const refScale = loadedPeaks.length
      ? loadedPeaks[Math.min(loadedPeaks.length - 1, Math.floor(PEAK_PERCENTILE * loadedPeaks.length))]
      : 0;

    for (let i = 0; i < pred.spots.length; i++) {
      const tileImg = tileImgsRef.current[i];
      if (!tileImg) continue;
      const s = pred.spots[i];
      if (s.gridX == null || s.gridY == null) continue;
      const r = tileRect(s, geom);
      // Scale this spot's opacity by how strong it really is relative to
      // the slide overall — without this every spot's overlay reads as
      // equally "hot" regardless of true signal strength, since each one
      // is independently normalised to its own peak. MIN_OPACITY keeps a
      // genuinely weak spot perceptible instead of fading to nothing.
      const peak = peaksRef.current[i] ?? 0;
      const rel = refScale > 0 ? Math.min(1, peak / refScale) : 1;
      ctx.globalAlpha = MIN_OPACITY + (1 - MIN_OPACITY) * rel;
      ctx.drawImage(tileImg, r.x, r.y, r.w, r.h);
    }
    ctx.globalAlpha = 1;
  }, [pred, width, height]);

  useEffect(() => {
    draw();
  }, [draw, imgTick]);

  // Real per-tile Grad-CAM (one backward pass per tile — see predictor.py's
  // explain_batch()), fetched in batches of REQUEST_BATCH_SIZE across every
  // tissue tile and painted into the mosaic as each batch arrives. No gene
  // target: each tile explains "why does this patch resemble its own
  // single nearest retrieved neighbour" — generic, not tied to any one
  // gene. This is still genuinely slow (real backward passes, on a single
  // shared CPU host) — batching cuts the per-tile overhead, not the actual
  // compute — so a full slide can still take minutes; the mosaic fills in
  // batch by batch rather than blocking on one giant request.
  useEffect(() => {
    const seq = ++seqRef.current;
    const controller = new AbortController();
    tileImgsRef.current = new Array(pred.spots.length).fill(null);
    peaksRef.current = new Array(pred.spots.length).fill(0);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting to the loading state on every upload change, guarded by seq against stale runs
    setLoadedCount(0);
    setFailedCount(0);
    setError("");
    setSelectedTile(null);
    viewRef.current = { scale: 1, panX: 0, panY: 0 };
    setZoomed(false);
    draw();

    if (!ready || !pred.spots.length) return;
    if (!file) {
      setError("This needs the original uploaded image. Re-upload the section (history-loaded predictions don't keep the file).");
      return;
    }

    // Target every spot against the slide's own top predicted gene — an
    // independent target, not each spot's self-selected nearest neighbour.
    // No UI picker involved, this is chosen automatically; see
    // explainGradcamBatch()'s docstring for why the self-referential
    // fallback is measurably weaker.
    const targetGene = pred.topGenes[0]?.name;

    setLoading(true);
    (async () => {
      let failed = 0;
      for (let start = 0; start < pred.spots.length; start += REQUEST_BATCH_SIZE) {
        if (seq !== seqRef.current) return;
        const indices = Array.from(
          { length: Math.min(REQUEST_BATCH_SIZE, pred.spots.length - start) },
          (_, k) => start + k,
        );
        try {
          const tiles = await explainGradcamBatch(file, indices, targetGene, controller.signal);
          if (seq !== seqRef.current) return;
          for (const t of tiles) {
            tileImgsRef.current[t.spot_index] = await loadTileImage(base64ToBlob(t.png_base64));
            peaksRef.current[t.spot_index] = t.peak;
          }
        } catch {
          if (controller.signal.aborted || seq !== seqRef.current) return;
          failed += indices.length;
          setFailedCount(failed);
        }
        if (seq !== seqRef.current) return;
        setLoadedCount(Math.min(start + REQUEST_BATCH_SIZE, pred.spots.length));
        draw();
      }
      if (seq === seqRef.current) setLoading(false);
    })();

    return () => {
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- draw is stable enough per render; re-running this on every draw identity change would restart the whole slide
  }, [file, ready, pred.spots.length]);

  // Lets you check progress without keeping this panel in view — the load
  // keeps running in the background regardless of tab focus, so a glance
  // at the browser tab title is enough to see how far along it is.
  const originalTitleRef = useRef<string | null>(null);
  useEffect(() => {
    if (originalTitleRef.current === null) originalTitleRef.current = document.title;
    return () => {
      if (originalTitleRef.current !== null) document.title = originalTitleRef.current;
    };
  }, []);
  useEffect(() => {
    if (!ready || total === 0) return;
    if (loading) {
      document.title = `Grad-CAM ${pct}% · GeneX`;
    } else if (loadedCount > 0) {
      document.title = `Grad-CAM ready · GeneX`;
    }
  }, [ready, loading, pct, loadedCount, total]);

  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      const cv = canvasRef.current;
      if (!cv) return;
      const rect = cv.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const view = viewRef.current;
      const factor = Math.exp(-e.deltaY * 0.001);
      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
      const worldX = (mx - view.panX) / view.scale;
      const worldY = (my - view.panY) / view.scale;
      view.panX = mx - worldX * newScale;
      view.panY = my - worldY * newScale;
      view.scale = newScale;
      clampPan(view, width, height > 0 ? Math.min(Math.round(width * 0.72), height) : Math.round(width * 0.72));
      setZoomed(view.scale > 1.001);
      draw();
    },
    [draw, width, height],
  );

  const pickTileAt = useCallback(
    (clientX: number, clientY: number) => {
      const cv = canvasRef.current;
      const img = imgRef.current;
      if (!cv || !img) return;
      const rect = cv.getBoundingClientRect();
      const mx = clientX - rect.left;
      const my = clientY - rect.top;
      const view = viewRef.current;
      const worldX = (mx - view.panX) / view.scale;
      const worldY = (my - view.panY) / view.scale;
      const h = height > 0 ? Math.min(Math.round(width * 0.72), height) : Math.round(width * 0.72);
      const geom = computeGeom(img, width, h);
      for (let i = 0; i < pred.spots.length; i++) {
        if (!tileImgsRef.current[i]) continue;
        const s = pred.spots[i];
        if (s.gridX == null || s.gridY == null) continue;
        const r = tileRect(s, geom);
        if (worldX >= r.x && worldX <= r.x + r.w && worldY >= r.y && worldY <= r.y + r.h) {
          setSelectedTile(i);
          return;
        }
      }
    },
    [pred, width, height],
  );

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    dragRef.current = { moved: false, lastX: e.clientX, lastY: e.clientY };
    setDragging(true);
  }, []);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.lastX;
      const dy = e.clientY - d.lastY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) d.moved = true;
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      const view = viewRef.current;
      view.panX += dx;
      view.panY += dy;
      const h = height > 0 ? Math.min(Math.round(width * 0.72), height) : Math.round(width * 0.72);
      clampPan(view, width, h);
      draw();
    },
    [draw, width, height],
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const d = dragRef.current;
      dragRef.current = null;
      setDragging(false);
      if (d && !d.moved) pickTileAt(e.clientX, e.clientY);
    },
    [pickTileAt],
  );

  const resetView = useCallback(() => {
    viewRef.current = { scale: 1, panX: 0, panY: 0 };
    setZoomed(false);
    draw();
  }, [draw]);

  // Zoom centred on the canvas's current middle — same math as the wheel
  // handler's cursor-centred zoom, just anchored to a fixed point instead
  // of the mouse position, for the explicit +/- buttons.
  const zoomBy = useCallback(
    (factor: number) => {
      const h = height > 0 ? Math.min(Math.round(width * 0.72), height) : Math.round(width * 0.72);
      const cx = width / 2;
      const cy = h / 2;
      const view = viewRef.current;
      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
      const worldX = (cx - view.panX) / view.scale;
      const worldY = (cy - view.panY) / view.scale;
      view.panX = cx - worldX * newScale;
      view.panY = cy - worldY * newScale;
      view.scale = newScale;
      clampPan(view, width, h);
      setZoomed(view.scale > 1.001);
      draw();
    },
    [draw, width, height],
  );

  useEffect(() => {
    if (selectedTile === null) return;
    const cv = detailCanvasRef.current;
    const img = tileImgsRef.current[selectedTile];
    if (!cv || !img) return;
    const dpr = window.devicePixelRatio || 1;
    const size = 360;
    cv.width = size * dpr;
    cv.height = size * dpr;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(img, 0, 0, size, size);
  }, [selectedTile]);

  // Shows which gene every spot is being targeted against — same value
  // passed to explainGradcamBatch() below, so this always reflects the
  // actual target, not just a label.
  const targetGeneLabel = pred.topGenes[0]?.name ? ` (target: ${pred.topGenes[0].name})` : "";
  const statusText = !ready
    ? ""
    : loading
      ? `computing Grad-CAM: spot ${loadedCount}/${total} (${pct}%)${targetGeneLabel}`
      : loadedCount > 0
        ? `Grad-CAM: ${total} spot${total === 1 ? "" : "s"}${targetGeneLabel}${failedCount ? `, ${failedCount} failed` : ""}`
        : "";

  if (!ready) {
    return (
      <div className="plot-body gradcam-body" style={{ display: hidden ? "none" : undefined }}>
        <div className="canvas-wrap gradcam-image">
          <div className="canvas-empty">Grad-CAM renders after prediction</div>
        </div>
      </div>
    );
  }

  return (
    <div className="plot-body" style={{ display: hidden ? "none" : undefined }}>
      <div className="gradcam-controls">
        <span className="page-label">{statusText}</span>
        {loading && (
          <div className="gradcam-progress-track">
            <div className="gradcam-progress-fill" style={{ width: `${pct}%` }} />
          </div>
        )}
        {!loading && loadedCount > 0 && (
          <span className="gradcam-hint">drag to pan · click a spot for detail</span>
        )}
        {imgTick > 0 && (
          <div className="gradcam-zoom-controls">
            <button type="button" className="gradcam-reset-btn" onClick={() => zoomBy(1 / ZOOM_STEP)} aria-label="Zoom out">
              −
            </button>
            <button type="button" className="gradcam-reset-btn" onClick={() => zoomBy(ZOOM_STEP)} aria-label="Zoom in">
              +
            </button>
          </div>
        )}
        {zoomed && (
          <button type="button" className="gradcam-reset-btn" onClick={resetView}>
            Reset view
          </button>
        )}
      </div>
      <div className="canvas-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          width={520}
          height={380}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          style={{ cursor: dragging ? "grabbing" : "grab" }}
        />
        {error && <div className="canvas-empty">{error}</div>}
      </div>
      {!error && (
        <>
          <div className="legend">
            <div className="vbar vbar-jet" />
          </div>
          <div className="vscale">
            <span>low</span>
            <span>Grad-CAM attention</span>
            <span>high</span>
          </div>
        </>
      )}

      {selectedTile !== null && (
        <div
          className="modal-backdrop visible"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSelectedTile(null);
          }}
        >
          <div className="modal" role="dialog" aria-modal="true" style={{ width: 420 }}>
            <div className="modal-header">
              <div>
                <div className="pretitle">Grad-CAM detail</div>
                <h2>Spot #{selectedTile + 1}</h2>
              </div>
              <button className="modal-close" onClick={() => setSelectedTile(null)} aria-label="Close">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="modal-body">
              <canvas
                ref={detailCanvasRef}
                width={360}
                height={360}
                style={{ width: "100%", height: "auto", borderRadius: 8, display: "block" }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
