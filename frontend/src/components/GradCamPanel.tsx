"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { explainGradcamBatch } from "@/lib/api";
import type { Prediction, Spot } from "@/lib/mockPrediction";
import { DEFAULT_TILING, tileOrigin, type Tiling } from "@/lib/tiling";

export interface GradCamStatus {
  loading: boolean;
  loadedCount: number;
  total: number;
  /** True once loadedCount > 0 and nothing is in flight — a snapshot is
   * available via the ref at this point. */
  ready: boolean;
}

export interface GradCamHandle {
  /** A PNG data URL of the current mosaic canvas exactly as rendered, or
   * null if nothing has loaded yet. Used by the PDF report export — it
   * reuses whatever the panel already computed rather than recomputing
   * Grad-CAM itself. */
  getSnapshot: () => string | null;
}


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

// Continuous-map rendering, used when the server sends each tile's raw heat
// grid. All tiles' heat cells are placed into ONE slide-wide grid, coloured
// against ONE shared scale (the SCALE_PERCENTILE-th percentile of the raw
// heat of all loaded tissue cells, so a single outlier cannot wash out the
// rest), and drawn as a single smoothly interpolated image. Colour therefore
// flows across tile borders instead of stopping at them, and the same colour
// means the same strength everywhere. OVERLAY_ALPHA matches the server's
// overlay_heatmap().
const SCALE_PERCENTILE = 0.98;
const OVERLAY_ALPHA = 0.4;
// The stitched grid is smoothed with a Gaussian of this width (in heat cells)
// before colouring. v7's ViT gives one value per 14px patch, which on its own
// reads as scattered dots; smoothing merges neighbouring cells into larger,
// closer-together blobs, and the shared scale is then re-fitted to the
// smoothed values so the strongest blobs still reach the top of the colour
// range. Chosen by comparing widths on real v7 heat (1.5 to 2.5).
const SMOOTH_SIGMA = 2;
// Cells with almost no attention fade out instead of being tinted dark blue
// (opacity ramps in between FADE_LO and FADE_HI of the shared scale). Tiles
// along the tissue edge are only partly tissue, and the pink background inside
// them has almost no attention; at constant opacity it showed as blue
// stair-step squares along the edge. Only the weakest cells are affected.
const FADE_LO = 0.03;
const FADE_HI = 0.22;
// Models that space tiles further apart than the tile size (v16-core: 224 px
// tiles every 290 px) leave gaps with no heat of their own. Opacity ramps in
// with how much of a cell's smoothed neighbourhood is covered by tiles
// (between COVER_LO and COVER_HI), so a gap between two tiles is filled by
// interpolation, while the strip beyond the last tile at the tissue edge fades
// out instead of spilling onto the glass.
const COVER_LO = 0.1;
const COVER_HI = 0.45;
const JET_LUT: [number, number, number][] = Array.from({ length: 256 }, (_, i) => {
  const x = i / 255;
  const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return [c(1.5 - Math.abs(4 * x - 3)), c(1.5 - Math.abs(4 * x - 2)), c(1.5 - Math.abs(4 * x - 1))];
});

interface TileHeat {
  heat: Float32Array;
  mask: Float32Array;
  h: number;
  w: number;
}

interface HeatGrid {
  cv: HTMLCanvasElement;
  cols: number;
  rows: number;
  tw: number;
  th: number;
  scale: number;
  /** Original-image pixels covered by one grid cell. */
  cellPx: number;
}

/** Separable Gaussian blur, edges replicated. */
function smoothstep(lo: number, hi: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

function blurGauss(src: Float32Array, cols: number, rows: number, sigma: number): Float32Array {
  const r = Math.ceil(3 * sigma);
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    k[i + r] = Math.exp(-0.5 * (i / sigma) ** 2);
    sum += k[i + r];
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let acc = 0;
      for (let d = -r; d <= r; d++) acc += k[d + r] * src[y * cols + Math.min(cols - 1, Math.max(0, x + d))];
      tmp[y * cols + x] = acc;
    }
  }
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let acc = 0;
      for (let d = -r; d <= r; d++) acc += k[d + r] * tmp[Math.min(rows - 1, Math.max(0, y + d)) * cols + x];
      out[y * cols + x] = acc;
    }
  }
  return out;
}

/** Places every loaded tile's heat cells at their true pixel position (a cell
 * is `tiling.tile / tw` image pixels, a tile starts at grid index * stride) in
 * one slide-wide grid, smooths it across tile borders and gaps, and colours it
 * against one shared scale into an RGBA canvas (one pixel per heat cell). Cells
 * outside tissue, or with almost no attention, stay transparent. Rebuilt after
 * each batch, not on every draw. */
function buildHeatGrid(spots: Spot[], tiles: (TileHeat | null)[], tiling: Tiling): HeatGrid | null {
  let tw = 0;
  let th = 0;
  let maxGX = -1;
  let maxGY = -1;
  for (let i = 0; i < spots.length; i++) {
    const t = tiles[i];
    const s = spots[i];
    if (!t || s.gridX == null || s.gridY == null) continue;
    if (tw === 0) {
      tw = t.w;
      th = t.h;
    }
    if (t.w !== tw || t.h !== th) continue;
    maxGX = Math.max(maxGX, s.gridX);
    maxGY = Math.max(maxGY, s.gridY);
  }
  if (maxGX < 0) return null;

  const cellPx = tiling.tile / tw;
  const originCell = (g: number) => Math.round((g * tiling.stride) / cellPx);
  const cols = originCell(maxGX) + tw;
  const rows = originCell(maxGY) + th;
  const heatG = new Float32Array(cols * rows);
  const maskG = new Float32Array(cols * rows);
  for (let i = 0; i < spots.length; i++) {
    const t = tiles[i];
    const s = spots[i];
    if (!t || s.gridX == null || s.gridY == null || t.w !== tw || t.h !== th) continue;
    for (let cy = 0; cy < th; cy++) {
      for (let cx = 0; cx < tw; cx++) {
        const j = cy * tw + cx;
        const p = (originCell(s.gridY) + cy) * cols + originCell(s.gridX) + cx;
        heatG[p] = t.heat[j] * t.mask[j];
        maskG[p] = t.mask[j];
      }
    }
  }
  // Blur heat weighted by the tissue mask, then divide by the blurred mask, so
  // values near the tissue edge are not pulled down by empty neighbours.
  const num = blurGauss(heatG, cols, rows, SMOOTH_SIGMA);
  const den = blurGauss(maskG, cols, rows, SMOOTH_SIGMA);
  const heat = new Float32Array(heatG.length);
  const inTissue: number[] = [];
  for (let p = 0; p < heat.length; p++) {
    heat[p] = den[p] > 1e-6 ? num[p] / den[p] : 0;
    if (den[p] >= 0.5) inTissue.push(heat[p]);
  }
  const sorted = Float32Array.from(inTissue).sort();
  const scale = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(SCALE_PERCENTILE * sorted.length))] : 0;

  const cv = document.createElement("canvas");
  cv.width = cols;
  cv.height = rows;
  const ctx = cv.getContext("2d");
  if (!ctx) return null;
  const img = ctx.createImageData(cols, rows);
  for (let p = 0; p < heat.length; p++) {
    const v = scale > 0 ? Math.min(1, Math.max(0, heat[p] / scale)) : 0;
    const [r, g, b] = JET_LUT[Math.round(v * 255)];
    img.data[4 * p] = r;
    img.data[4 * p + 1] = g;
    img.data[4 * p + 2] = b;
    img.data[4 * p + 3] = Math.round(255 * OVERLAY_ALPHA * smoothstep(COVER_LO, COVER_HI, den[p]) * smoothstep(FADE_LO, FADE_HI, v));
  }
  ctx.putImageData(img, 0, 0);
  return { cv, cols, rows, tw, th, scale, cellPx };
}

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
 * steps by the tiling's stride (tile spacing); size is the tile's own
 * footprint. The two differ when the model leaves gaps between tiles
 * (e.g. 224 px tiles every 290 px). */
function tileRect(s: Spot, g: ImgGeom, tiling: Tiling) {
  const [ox, oy] = tileOrigin(s.gridX ?? 0, s.gridY ?? 0, tiling);
  const x = ((ox - g.sx) / g.sw) * g.w;
  const y = ((oy - g.sy) / g.sh) * g.h;
  const w = (tiling.tile / g.sw) * g.w;
  const h = (tiling.tile / g.sh) * g.h;
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

const GradCamPanel = forwardRef<GradCamHandle, {
  pred: Prediction;
  ready: boolean;
  file: File | null;
  // History-loaded runs retrieve the original file after the prediction
  // itself has loaded: "loading" while that is in flight, "failed" if it
  // could not be retrieved.
  fileStatus?: "idle" | "loading" | "failed";
  imageUrl?: string | null;
  // Visually hides the panel without unmounting it — the loading effect
  // keeps running and already-loaded tiles stay in memory while another
  // tab is showing, instead of losing all progress on every tab switch.
  hidden?: boolean;
  /** Reported on every loading-state change, so GeneXApp can gate the PDF
   * report export on Grad-CAM actually being ready for this prediction. */
  onStatusChange?: (status: GradCamStatus) => void;
}>(function GradCamPanel(
  { pred, ready, file, fileStatus = "idle", imageUrl, hidden, onStatusChange },
  ref,
) {
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
  // Continuous-map path: each spot's raw heat grid, and the stitched
  // slide-wide grid built from them (see buildHeatGrid).
  const heatRef = useRef<(TileHeat | null)[]>([]);
  const gridRef = useRef<HeatGrid | null>(null);
  const viewRef = useRef<ViewState>({ scale: 1, panX: 0, panY: 0 });
  const dragRef = useRef<{ moved: boolean; lastX: number; lastY: number } | null>(null);
  // Always the latest onStatusChange, read (not depended on) from inside
  // the loading effect below — avoids re-running that effect every time
  // the parent passes a new inline callback.
  const onStatusChangeRef = useRef(onStatusChange);
  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  });

  useImperativeHandle(ref, () => ({
    getSnapshot: () => canvasRef.current?.toDataURL("image/png") ?? null,
  }), []);

  const [width, setWidth] = useState(520);
  const [height, setHeight] = useState(0);
  const [imgTick, setImgTick] = useState(0);
  const [loadedCount, setLoadedCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedTile, setSelectedTile] = useState<number | null>(null);
  const [zoomed, setZoomed] = useState(false);
  // > 0 once the continuous map is active; the value is the colour bar's
  // top end, in raw heat units.
  const [scaleShown, setScaleShown] = useState(0);
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
      const r = tileRect(s, geom, pred.tiling ?? DEFAULT_TILING);
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

    // The stitched heat map: one image spanning every tile, interpolated
    // smoothly, so there are no per-tile edges or per-tile brightness steps.
    const grid = gridRef.current;
    if (grid) {
      const gx = ((0 - geom.sx) / geom.sw) * geom.w;
      const gy = ((0 - geom.sy) / geom.sh) * geom.h;
      // Each grid cell is cellPx image pixels, so every tile's heat covers
      // exactly the pixels it was computed from, whatever the tile spacing.
      const gw = ((grid.cols * grid.cellPx) / geom.sw) * geom.w;
      const gh = ((grid.rows * grid.cellPx) / geom.sh) * geom.h;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(grid.cv, gx, gy, gw, gh);
    }
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
    const total = pred.spots.length;
    const report = (loadingNow: boolean, loaded: number) =>
      onStatusChangeRef.current?.({ loading: loadingNow, loadedCount: loaded, total, ready: !loadingNow && loaded > 0 });

    tileImgsRef.current = new Array(total).fill(null);
    peaksRef.current = new Array(total).fill(0);
    heatRef.current = new Array(total).fill(null);
    gridRef.current = null;
    setLoadedCount(0);
    setScaleShown(0);
    setFailedCount(0);
    setError("");
    setSelectedTile(null);
    viewRef.current = { scale: 1, panX: 0, panY: 0 };
    setZoomed(false);
    draw();
    report(false, 0);

    if (!ready || !total) return;
    if (!file) {
      setError(
        fileStatus === "loading"
          ? "Retrieving the original image from history…"
          : fileStatus === "failed"
            ? "The original image could not be retrieved from history. Re-upload the section to generate Grad-CAM."
            : "Grad-CAM requires the original uploaded image. Re-upload the section to generate it.",
      );
      return;
    }

    // Target every spot against the slide's own top predicted gene — an
    // independent target, not each spot's self-selected nearest neighbour.
    // No UI picker involved, this is chosen automatically; see
    // explainGradcamBatch()'s docstring for why the self-referential
    // fallback is measurably weaker.
    const targetGene = pred.topGenes[0]?.name;

    setLoading(true);
    report(true, 0);
    (async () => {
      let failed = 0;
      for (let start = 0; start < total; start += REQUEST_BATCH_SIZE) {
        if (seq !== seqRef.current) return;
        const indices = Array.from(
          { length: Math.min(REQUEST_BATCH_SIZE, total - start) },
          (_, k) => start + k,
        );
        try {
          const tiles = await explainGradcamBatch(file, indices, targetGene, controller.signal);
          if (seq !== seqRef.current) return;
          for (const t of tiles) {
            if (t.heat && t.mask && t.heat_size) {
              heatRef.current[t.spot_index] = {
                heat: Float32Array.from(t.heat),
                mask: Float32Array.from(t.mask),
                h: t.heat_size[0],
                w: t.heat_size[1],
              };
            } else {
              tileImgsRef.current[t.spot_index] = await loadTileImage(base64ToBlob(t.png_base64));
            }
            peaksRef.current[t.spot_index] = t.peak;
          }
          gridRef.current = buildHeatGrid(pred.spots, heatRef.current, pred.tiling ?? DEFAULT_TILING);
          setScaleShown(gridRef.current?.scale ?? 0);
        } catch {
          if (controller.signal.aborted || seq !== seqRef.current) return;
          failed += indices.length;
          setFailedCount(failed);
        }
        if (seq !== seqRef.current) return;
        const loadedSoFar = Math.min(start + REQUEST_BATCH_SIZE, total);
        setLoadedCount(loadedSoFar);
        draw();
        report(true, loadedSoFar);
      }
      if (seq === seqRef.current) {
        setLoading(false);
        report(false, total);
      }
    })();

    return () => {
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- draw is stable enough per render; re-running this on every draw identity change would restart the whole slide
  }, [file, fileStatus, ready, pred.spots.length]);

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
        if (!tileImgsRef.current[i] && !heatRef.current[i]) continue;
        const s = pred.spots[i];
        if (s.gridX == null || s.gridY == null) continue;
        const r = tileRect(s, geom, pred.tiling ?? DEFAULT_TILING);
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
    const th = heatRef.current[selectedTile];
    if (!cv || (!img && !th)) return;
    const dpr = window.devicePixelRatio || 1;
    const size = 360;
    cv.width = size * dpr;
    cv.height = size * dpr;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    if (th) {
      // Continuous-map path: the tile's own pixels from the slide, then its
      // slice of the stitched map, so it matches the mosaic exactly.
      const s = pred.spots[selectedTile];
      const base = imgRef.current;
      const grid = gridRef.current;
      if (base && s.gridX != null && s.gridY != null) {
        const tiling = pred.tiling ?? DEFAULT_TILING;
        const [ox, oy] = tileOrigin(s.gridX, s.gridY, tiling);
        ctx.drawImage(base, ox, oy, tiling.tile, tiling.tile, 0, 0, size, size);
        if (grid) {
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          const sx = Math.round((s.gridX * tiling.stride) / grid.cellPx);
          const sy = Math.round((s.gridY * tiling.stride) / grid.cellPx);
          ctx.drawImage(grid.cv, sx, sy, grid.tw, grid.th, 0, 0, size, size);
        }
      }
      return;
    }
    if (img) ctx.drawImage(img, 0, 0, size, size);
  }, [selectedTile, pred.spots, pred.tiling]);

  const statusText = !ready
    ? ""
    : loading
      ? `computing Grad-CAM: spot ${loadedCount}/${total} (${pct}%)`
      : loadedCount > 0
        ? `Grad-CAM: ${total} spot${total === 1 ? "" : "s"}${failedCount ? `, ${failedCount} failed` : ""}`
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
            {scaleShown > 0 ? (
              <>
                <span>0</span>
                <span>Grad-CAM attention, one scale for the whole slide</span>
                <span>{scaleShown.toPrecision(2)}+</span>
              </>
            ) : (
              <>
                <span>low</span>
                <span>Grad-CAM attention</span>
                <span>high</span>
              </>
            )}
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
});

export default GradCamPanel;
