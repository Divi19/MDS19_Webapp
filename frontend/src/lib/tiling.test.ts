import { describe, expect, it } from "vitest";
import { toPrediction } from "@/lib/api";
import { DEFAULT_TILING, tileCentre, tileOrigin, tilingFromApi, tissueViewRect } from "@/lib/tiling";
import { OLD_RESPONSE } from "@/test/fixtures";

describe("tiling", () => {
  it("uses the API's tile size and spacing when both are reported", () => {
    expect(tilingFromApi({ tile_px: 224, stride_px: 290 })).toEqual({ tile: 224, stride: 290 });
  });

  it("falls back to 224/224 when the API does not report tiling", () => {
    expect(tilingFromApi({})).toEqual(DEFAULT_TILING);
    expect(tilingFromApi({ tile_px: null, stride_px: null, model_version: "anything" })).toEqual(DEFAULT_TILING);
    // Half or invalid values are ignored rather than mixed with defaults.
    expect(tilingFromApi({ tile_px: 224 })).toEqual(DEFAULT_TILING);
    expect(tilingFromApi({ tile_px: 0, stride_px: 290 })).toEqual(DEFAULT_TILING);
  });

  it("places a tile at col*stride with its centre half a tile in", () => {
    // v7 Modal: 224 px crops every 290 px — tile (3, 2) starts at (870, 580).
    const v7 = { tile: 224, stride: 290 };
    expect(tileOrigin(3, 2, v7)).toEqual([870, 580]);
    expect(tileCentre(3, 2, v7)).toEqual([982, 692]);
    // Local MclSTExp: no gaps.
    expect(tileCentre(3, 2, DEFAULT_TILING)).toEqual([784, 560]);
  });

  it("carries tiling from the predict response into the prediction", () => {
    expect(toPrediction({ ...OLD_RESPONSE, tile_px: 224, stride_px: 290 }).tiling).toEqual({ tile: 224, stride: 290 });
    expect(toPrediction(OLD_RESPONSE).tiling).toEqual(DEFAULT_TILING);
  });
});

describe("tissueViewRect", () => {
  // A 4000x6000 "A4" scan whose tissue (tiles 2..5 across, 20..23 down) sits near the bottom-left.
  const spots = [
    { gridX: 2, gridY: 20 },
    { gridX: 5, gridY: 23 },
  ];

  it("centres the tissue bounding box in the view", () => {
    const r = tissueViewRect(4000, 6000, spots, DEFAULT_TILING, 800, 600);
    const [x0, y0] = tileOrigin(2, 20, DEFAULT_TILING);
    const [x1, y1] = tileOrigin(5, 23, DEFAULT_TILING);
    const cx = (x0 + x1 + DEFAULT_TILING.tile) / 2;
    const cy = (y0 + y1 + DEFAULT_TILING.tile) / 2;
    expect(r.sx + r.sw / 2).toBeCloseTo(cx);
    expect(r.sy + r.sh / 2).toBeCloseTo(cy);
  });

  it("keeps the canvas aspect ratio and contains every tile", () => {
    const r = tissueViewRect(4000, 6000, spots, DEFAULT_TILING, 800, 600);
    expect(r.sw / r.sh).toBeCloseTo(800 / 600);
    const [x0, y0] = tileOrigin(2, 20, DEFAULT_TILING);
    const [x1, y1] = tileOrigin(5, 23, DEFAULT_TILING);
    expect(r.sx).toBeLessThanOrEqual(x0);
    expect(r.sy).toBeLessThanOrEqual(y0);
    expect(r.sx + r.sw).toBeGreaterThanOrEqual(x1 + DEFAULT_TILING.tile);
    expect(r.sy + r.sh).toBeGreaterThanOrEqual(y1 + DEFAULT_TILING.tile);
  });

  it("stays inside the image when the tissue touches an edge", () => {
    const edge = [
      { gridX: 0, gridY: 2 },
      { gridX: 3, gridY: 6 },
    ];
    const r = tissueViewRect(4000, 6000, edge, DEFAULT_TILING, 800, 600);
    expect(r.sx).toBe(0);
    expect(r.sx + r.sw).toBeLessThanOrEqual(4000);
    expect(r.sy).toBeGreaterThanOrEqual(0);
    expect(r.sy + r.sh).toBeLessThanOrEqual(6000);
    expect(r.sw / r.sh).toBeCloseTo(800 / 600);
  });

  it("falls back to a centred cover-fit with no grid spots", () => {
    const r = tissueViewRect(2000, 1000, [{}], DEFAULT_TILING, 500, 500);
    expect(r).toEqual({ sx: 500, sy: 0, sw: 1000, sh: 1000 });
  });
});
