import { afterEach, describe, expect, it, vi } from "vitest";
import { buildROIGeometries, downloadBlob } from "@/lib/export";
import { predictionFixture } from "@/test/fixture";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("research export helpers", () => {
  it("builds ROI geometry only from returned tile bounds", () => {
    const prediction = predictionFixture();
    const geometries = buildROIGeometries(prediction, [0, 2], [1]);
    expect(geometries).toHaveLength(2);
    expect(geometries[0].geometry.type).toBe("MultiPolygon");
    expect(geometries[0].tile_indices).toEqual([0, 2]);
    expect(geometries[0].properties.geometry_source).toBe("returned_prediction_tile_bounds");
  });

  it("rejects empty downloads and activates non-empty blobs", () => {
    expect(() => downloadBlob(new Blob([]), "empty.zip")).toThrow("Cannot download empty file");
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:test"),
      revokeObjectURL: vi.fn(),
    });
    expect(downloadBlob(new Blob(["data"], { type: "application/zip" }), "result.zip")).toBe("result.zip");
    expect(click).toHaveBeenCalledOnce();
  });
});
