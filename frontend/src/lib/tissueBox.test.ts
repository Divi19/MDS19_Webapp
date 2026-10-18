import { describe, expect, it } from "vitest";
import { tissueBoxFromGray } from "@/lib/tissueBox";

/** w x h bright "glass" image with dark rectangles painted on it. */
function slide(w: number, h: number, rects: [number, number, number, number][], glass = 230, tissue = 90) {
  const g = new Uint8Array(w * h).fill(glass);
  for (const [x0, y0, x1, y1] of rects)
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) g[y * w + x] = tissue;
  return g;
}

describe("tissueBoxFromGray", () => {
  it("finds a tissue block in a corner of the slide", () => {
    const box = tissueBoxFromGray(slide(200, 300, [[10, 200, 80, 290]]), 200, 300);
    expect(box).toEqual({ x0: 10, y0: 200, x1: 80, y1: 290 });
  });

  it("ignores isolated specks outside the tissue", () => {
    const g = slide(200, 300, [[50, 100, 150, 200]]);
    g[5 * 200 + 5] = 90; // one dark pixel of dust in the corner
    g[290 * 200 + 190] = 90;
    expect(tissueBoxFromGray(g, 200, 300)).toEqual({ x0: 50, y0: 100, x1: 150, y1: 200 });
  });

  it("returns null for a blank slide", () => {
    expect(tissueBoxFromGray(slide(100, 100, []), 100, 100)).toBeNull();
  });

  it("returns null when tissue fills the whole frame", () => {
    expect(tissueBoxFromGray(slide(100, 100, [[0, 0, 100, 100]]), 100, 100)).toBeNull();
  });
});
