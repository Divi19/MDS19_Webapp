import { afterEach, describe, expect, it, vi } from "vitest";
import { predict } from "@/lib/api";
import { predictionFixture } from "@/test/fixture";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("prediction API", () => {
  it("sends the required scientific metadata without transforming the response", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body as FormData;
      expect(body.get("her2_positive_breast_tissue")).toBe("true");
      expect(body.get("stain")).toBe("H&E");
      expect(body.get("microns_per_pixel")).toBe("0.5");
      return new Response(JSON.stringify(predictionFixture()), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const response = await predict(new File(["image"], "sample.png", { type: "image/png" }), true, true, 0.5);
    expect(response.prediction_tiles[1].expression.ERBB2).toBe(5);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("surfaces stable backend detail errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "Real mode requires microns-per-pixel" }), { status: 422, headers: { "Content-Type": "application/json" } })));
    await expect(predict(new File(["image"], "sample.png", { type: "image/png" }), true, true, 0.5)).rejects.toThrow("Real mode requires microns-per-pixel");
  });
});
