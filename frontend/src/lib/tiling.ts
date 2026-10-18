/**
 * How a prediction's spot grid indices map back to pixels on the original
 * upload. Tile (gridX, gridY) covers
 *   [gridX * stride, gridX * stride + tile) x [gridY * stride, gridY * stride + tile)
 * in original-image pixels. The spot's centre is gridX * stride + tile / 2.
 *
 * Different models tile differently: the local MclSTExp backend and the
 * old v7 Modal model both use 224 px tiles every 224 px (no gaps); v16-core
 * uses 224 px tiles every 290 px (200 µm at ~0.69 µm/px). Drawing one
 * model's grid with another's spacing shifts every spot, so the spacing
 * travels with each prediction instead of being a frontend constant.
 */

export interface Tiling {
  /** Tile size in original-image pixels. */
  tile: number;
  /** Distance between neighbouring tiles' origins in original-image pixels. */
  stride: number;
}

/** The original v7/MclSTExp tiling: 224 px tiles, no gaps. */
export const DEFAULT_TILING: Tiling = { tile: 224, stride: 224 };

/**
 * Tiling for predictions that do not report it themselves (made before the
 * API sent tile_px/stride_px, or reopened from History saved before then),
 * keyed by model_version prefix. Add the serving model's version string here
 * if its runs were saved without tiling.
 *
 * v7 needs no entry: it used 224/224, which is already DEFAULT_TILING, so
 * old v7 rows fall through to the right answer on their own. v16-core does
 * need one — its 224/290 differs from the default, so a v16-core row saved
 * before this field existed would otherwise silently read back as 224/224.
 */
export const TILING_BY_MODEL_VERSION: [prefix: string, tiling: Tiling][] = [
  ["v16-core", { tile: 224, stride: 290 }],
];

function validPx(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** The tiling of a prediction: the API's tile_px/stride_px when both are
 * present and valid, else a known model_version, else DEFAULT_TILING. */
export function tilingFromApi(response: {
  tile_px?: number | null;
  stride_px?: number | null;
  model_version?: string | null;
}): Tiling {
  if (validPx(response.tile_px) && validPx(response.stride_px)) {
    return { tile: response.tile_px, stride: response.stride_px };
  }
  const version = response.model_version ?? "";
  const known = TILING_BY_MODEL_VERSION.find(([prefix]) => version.startsWith(prefix));
  return known ? known[1] : DEFAULT_TILING;
}

/** A spot's tile origin (top-left) in original-image pixels. */
export function tileOrigin(gridX: number, gridY: number, tiling: Tiling): [number, number] {
  return [gridX * tiling.stride, gridY * tiling.stride];
}

/** A spot's tile centre in original-image pixels. */
export function tileCentre(gridX: number, gridY: number, tiling: Tiling): [number, number] {
  return [gridX * tiling.stride + tiling.tile / 2, gridY * tiling.stride + tiling.tile / 2];
}

/** A source rectangle in original-image pixels, with the canvas's aspect ratio. */
export interface ViewRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** Margin kept around the tissue, as a fraction of its size on each side. */
const TISSUE_VIEW_PAD = 0.06;

/** The view rect for a tissue bounding box (original-image pixels): centred
 * on the box, containing it plus a margin, and kept inside the image. */
export function viewRectForBox(
  imgW: number,
  imgH: number,
  box: { x0: number; y0: number; x1: number; y1: number },
  cw: number,
  ch: number,
): ViewRect {
  const cr = cw / ch;
  const minX = box.x0;
  const minY = box.y0;
  const maxX = box.x1;
  const maxY = box.y1;
  const bw = (maxX - minX) * (1 + 2 * TISSUE_VIEW_PAD);
  const bh = (maxY - minY) * (1 + 2 * TISSUE_VIEW_PAD);
  let sw = Math.max(bw, bh * cr);
  let sh = sw / cr;
  // Never show blank space past the image: shrink to fit inside it (only the
  // margin is lost in practice), then slide the rect back in. Tissue touching
  // an image edge is therefore centred as far as the image allows.
  const fit = Math.min(1, imgW / sw, imgH / sh);
  sw *= fit;
  sh *= fit;
  const sx = Math.min(Math.max((minX + maxX) / 2 - sw / 2, 0), imgW - sw);
  const sy = Math.min(Math.max((minY + maxY) / 2 - sh / 2, 0), imgH - sh);
  return { sx, sy, sw, sh };
}

/**
 * The part of the original image to show in a cw x ch canvas so the tissue is
 * centred and fills the view, wherever it sits on the upload (e.g. a small
 * section in the bottom-left corner of an A4 scan). Fits the bounding box of
 * the predicted tiles plus a margin, kept inside the image so the view never
 * shows blank space. With no usable spots (demo data), falls back to
 * a centred cover-fit of the whole image.
 */
export function tissueViewRect(
  imgW: number,
  imgH: number,
  spots: { gridX?: number | null; gridY?: number | null }[],
  tiling: Tiling,
  cw: number,
  ch: number,
): ViewRect {
  const cr = cw / ch;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of spots) {
    if (s.gridX == null || s.gridY == null) continue;
    const [ox, oy] = tileOrigin(s.gridX, s.gridY, tiling);
    minX = Math.min(minX, ox);
    minY = Math.min(minY, oy);
    maxX = Math.max(maxX, ox + tiling.tile);
    maxY = Math.max(maxY, oy + tiling.tile);
  }
  if (!Number.isFinite(minX)) {
    // Centred cover-fit of the whole image.
    if (imgW / imgH > cr) {
      const sh = imgH;
      const sw = sh * cr;
      return { sx: (imgW - sw) / 2, sy: 0, sw, sh };
    }
    const sw = imgW;
    const sh = sw / cr;
    return { sx: 0, sy: (imgH - sh) / 2, sw, sh };
  }
  return viewRectForBox(imgW, imgH, { x0: minX, y0: minY, x1: maxX, y1: maxY }, cw, ch);
}

/** Draws `rect` of `img` into a w x h canvas, filling anywhere the rect
 * extends past the image with `background` (drawImage with an out-of-range
 * source rect is not portable, so only the overlap is drawn). */
export function drawImageRect(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  rect: ViewRect,
  w: number,
  h: number,
  background = "#faf8f3",
) {
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, w, h);
  const x0 = Math.max(rect.sx, 0);
  const y0 = Math.max(rect.sy, 0);
  const x1 = Math.min(rect.sx + rect.sw, img.naturalWidth);
  const y1 = Math.min(rect.sy + rect.sh, img.naturalHeight);
  if (x1 <= x0 || y1 <= y0) return;
  const kx = w / rect.sw;
  const ky = h / rect.sh;
  ctx.drawImage(img, x0, y0, x1 - x0, y1 - y0, (x0 - rect.sx) * kx, (y0 - rect.sy) * ky, (x1 - x0) * kx, (y1 - y0) * ky);
}

