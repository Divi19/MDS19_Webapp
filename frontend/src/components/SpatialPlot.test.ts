import { describe, expect, it } from "vitest";
import { tileIdentifier } from "@/components/SpatialPlot";
import type { PredictionTile } from "@/lib/types";

function tile(tileIndex: number | null, spotIndex: number): PredictionTile {
  return {
    spot_index: spotIndex,
    tile_index: tileIndex,
    x: 0,
    y: 0,
    bounds: null,
    expression: { ERBB2: 1 },
    retrieval_support: null,
  };
}

describe("prediction tile identifiers", () => {
  it("uses backend tile indices for real predictions", () => {
    expect(tileIdentifier(tile(7, 2))).toBe(7);
  });

  it("falls back to spot indices so demo ROI selection remains usable", () => {
    expect(tileIdentifier(tile(null, 12))).toBe(12);
  });
});
