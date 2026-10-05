import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { toPrediction } from "@/lib/api";
import { TISSUE_DISCLAIMER } from "@/lib/tissue";
import { OLD_RESPONSE, TISSUE_RESPONSE } from "@/test/fixtures";
import SpatialPlot from "./SpatialPlot";
import TissueLayerToggle from "./TissueLayerToggle";
import TissueSummary from "./TissueSummary";

beforeAll(() => {
  // jsdom has no canvas or ResizeObserver; the viewer only needs them to
  // exist (drawing calls become no-ops).
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  const ctx = new Proxy({}, { get: () => () => undefined, set: () => true });
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ctx) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

afterEach(cleanup);

describe("TissueLayerToggle", () => {
  it("is hidden for a prediction without tissue data", () => {
    const { container } = render(
      <TissueLayerToggle tissue={toPrediction(OLD_RESPONSE).tissue} layer="expression" onChange={() => {}} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("is shown, defaults to expression and switches layers", () => {
    const onChange = vi.fn();
    render(<TissueLayerToggle tissue={toPrediction(TISSUE_RESPONSE).tissue} layer="expression" onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Gene expression" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Tissue type" }));
    expect(onChange).toHaveBeenCalledWith("tissue");
  });
});

describe("SpatialPlot tissue layer", () => {
  it("renders the legend with counts and percentages and the disclaimer", () => {
    render(<SpatialPlot pred={toPrediction(TISSUE_RESPONSE)} ready view="genes" gene="ERBB2" layer="tissue" />);
    expect(screen.getByRole("button", { name: /Cancer\s*3 · 75\.0%/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Adipose tissue\s*1 · 25\.0%/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Immune infiltrate\s*0 · 0\.0%/ })).toBeTruthy();
    expect(screen.getByText(TISSUE_DISCLAIMER)).toBeTruthy();
  });

  it("shows class, confidence and all five probabilities in the tooltip", () => {
    const { container } = render(
      <SpatialPlot pred={toPrediction(TISSUE_RESPONSE)} ready view="genes" gene="ERBB2" layer="tissue" />,
    );
    // Default 520px-wide grid layout: margins 34/10, plot 476 x 340, so the
    // spot at normalised (0, 0) sits at (34, 10).
    fireEvent.mouseMove(container.querySelector("canvas")!, { clientX: 34, clientY: 10 });
    const tip = container.querySelector(".plot-tip")!;
    expect(tip.textContent).toContain("Cancer · 90.0%");
    expect(tip.querySelectorAll(".tip-prob")).toHaveLength(5);
    expect(tip.textContent).toContain("ERBB2");
  });

  it("flags low-confidence spots in the tooltip", () => {
    const { container } = render(
      <SpatialPlot pred={toPrediction(TISSUE_RESPONSE)} ready view="genes" gene="ERBB2" layer="tissue" />,
    );
    fireEvent.mouseMove(container.querySelector("canvas")!, { clientX: 34, clientY: 350 });
    expect(container.querySelector(".plot-tip")!.textContent).toContain("low confidence");
  });

  it("renders an old prediction with no tissue UI, even if the tissue layer is requested", () => {
    const { container } = render(
      <SpatialPlot pred={toPrediction(OLD_RESPONSE)} ready view="genes" gene="ERBB2" layer="tissue" />,
    );
    expect(container.querySelector(".tissue-legend")).toBeNull();
    expect(screen.queryByText(TISSUE_DISCLAIMER)).toBeNull();
    expect(container.querySelector(".vbar")).not.toBeNull();
    fireEvent.mouseMove(container.querySelector("canvas")!, { clientX: 34, clientY: 10 });
    expect(container.querySelector(".tip-tissue")).toBeNull();
  });
});

describe("TissueSummary", () => {
  it("shows the cancer area and a stacked bar of class fractions", () => {
    const tissue = toPrediction(TISSUE_RESPONSE).tissue!;
    render(<TissueSummary tissue={tissue} total={4} />);
    expect(screen.getByText(/Cancer area:/).textContent).toBe("Cancer area: 75.0% of spots");
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("Adipose tissue 25.0%");
  });
});
