import { describe, expect, it } from "vitest";
import { toPrediction } from "@/lib/api";
import { DEFAULT_TILING, tileCentre, tileOrigin, tilingFromApi } from "@/lib/tiling";
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
