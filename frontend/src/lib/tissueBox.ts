/** Tissue bounding box found from the image alone — for the landing-page
 * preview, shown before any prediction exists to say where the tissue is.
 * Coordinates are in whatever pixel grid the input was in; x1/y1 exclusive. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const MIN_TISSUE_FRACTION = 0.005; // below this the "tissue" is just specks
const MAX_TISSUE_FRACTION = 0.92; // above this there is no real background to split off
const MIN_LINE_FRACTION = 0.015; // a row/column needs this share of tissue pixels

/** Otsu's threshold over a 256-bin histogram: the grey level that best
 * separates dark (tissue) from light (glass). */
function otsu(hist: number[], total: number): number {
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > bestVar) {
      bestVar = between;
      best = t;
    }
  }
  return best;
}

/** Bounding box of the dark region of a w x h greyscale image (green channel
 * of an H&E scan: both stains absorb it, glass does not). Rows and columns
 * with almost no tissue are ignored so dust and edge artefacts do not stretch
 * the box. Null when there is nothing separable from the background. */
export function tissueBoxFromGray(gray: ArrayLike<number>, w: number, h: number): Box | null {
  const n = w * h;
  if (n === 0) return null;
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < n; i++) hist[gray[i]]++;
  const t = otsu(hist, n);

  const cols = new Array<number>(w).fill(0);
  const rows = new Array<number>(h).fill(0);
  let tissue = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (gray[y * w + x] <= t) {
        cols[x]++;
        rows[y]++;
        tissue++;
      }
    }
  }
  const frac = tissue / n;
  if (frac < MIN_TISSUE_FRACTION || frac > MAX_TISSUE_FRACTION) return null;

  const colMin = Math.max(2, MIN_LINE_FRACTION * h);
  const rowMin = Math.max(2, MIN_LINE_FRACTION * w);
  const x0 = cols.findIndex((c) => c >= colMin);
  const y0 = rows.findIndex((c) => c >= rowMin);
  const x1 = w - [...cols].reverse().findIndex((c) => c >= colMin);
  const y1 = h - [...rows].reverse().findIndex((c) => c >= rowMin);
  if (x0 < 0 || y0 < 0 || x1 <= x0 || y1 <= y0) return null;
  return { x0, y0, x1, y1 };
}

const ANALYSIS_SIDE = 320;

/** Tissue box of a loaded image in its own pixel coordinates, found on a
 * downscaled copy. Null if nothing is found or the canvas cannot be read. */
export function detectTissueBox(img: HTMLImageElement): Box | null {
  try {
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    if (!iw || !ih) return null;
    const scale = Math.min(1, ANALYSIS_SIDE / Math.max(iw, ih));
    const w = Math.max(1, Math.round(iw * scale));
    const h = Math.max(1, Math.round(ih * scale));
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const gray = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) gray[i] = px[i * 4 + 1];
    const box = tissueBoxFromGray(gray, w, h);
    if (!box) return null;
    return { x0: box.x0 / scale, y0: box.y0 / scale, x1: box.x1 / scale, y1: box.y1 / scale };
  } catch {
    return null;
  }
}
