import { describe, expect, it } from "vitest";
import { answer } from "@/lib/agent";
import { predictionFixture } from "@/test/fixture";

describe("evidence reader", () => {
  it("locates the highest raw predicted gene tile without biological interpretation", () => {
    const response = answer("Where is ERBB2 highest?", predictionFixture());
    expect(response).toContain("Predicted: ERBB2");
    expect(response).toContain("tile 1: 5");
    expect(response).toContain("not a measured assay value");
  });

  it("summarizes only returned domain contrasts", () => {
    const response = answer("Summarize domain_2", predictionFixture());
    expect(response).toContain("domain_2 contains 2 tiles");
    expect(response).toContain("ERBB2 rank 1");
    expect(response).toContain("not measured markers");
  });

  it("states retrieval and interpretation limits", () => {
    const methods = answer("Explain retrieval support and methods", predictionFixture());
    expect(methods).toContain("inverse_squared_l1_distance");
    expect(methods).toContain("not calibrated confidence");
    const limits = answer("State warnings and limitations", predictionFixture());
    expect(limits).toContain("Research use only");
    expect(limits).toContain("does not establish diagnosis");
  });
});
