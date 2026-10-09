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
