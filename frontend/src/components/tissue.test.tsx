import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { toPrediction } from "@/lib/api";
import { OLD_RESPONSE, TISSUE_RESPONSE } from "@/test/fixtures";
import SpatialPlot from "./SpatialPlot";
import TissueInsights from "./TissueInsights";

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

// Default 520px-wide grid layout: margins 34/10, plot 476 x 340, so the spot
// at normalised (0, 0) sits at (34, 10) and (0, 1) at (34, 350).
const hover = (container: HTMLElement, x: number, y: number) =>
  fireEvent.mouseMove(container.querySelector("canvas")!, { clientX: x, clientY: y });

describe("SpatialPlot Tissue view — tissue types", () => {
  const renderTypes = () =>
    render(<SpatialPlot pred={toPrediction(TISSUE_RESPONSE)} ready view="tissue" gene="ERBB2" tissueMode="types" />);

  it("shows class pills with counts and percentages, and no confidence pill", () => {
    renderTypes();
    expect(screen.getByRole("button", { name: /Cancer\s*3 · 75\.0%/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Adipose tissue\s*1 · 25\.0%/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Immune infiltrate\s*0 · 0\.0%/ })).toBeTruthy();
    expect(screen.queryByText(/confidence </)).toBeNull();
  });

  it("shows no status text, disclaimer or uncertain-only filter under the map", () => {
    const { container } = renderTypes();
    expect(container.querySelector(".tissue-status")).toBeNull();
    expect(screen.queryByText(/not for diagnosis/)).toBeNull();
    expect(screen.queryByLabelText("Show only uncertain")).toBeNull();
  });

  it("shows class, confidence and all five probabilities in the tooltip", () => {
    const { container } = renderTypes();
    hover(container, 34, 10);
    const tip = container.querySelector(".plot-tip")!;
    expect(tip.textContent).toContain("Cancer · 90.0%");
    expect(tip.textContent).toContain("ERBB2");
    expect(tip.querySelectorAll(".tip-prob")).toHaveLength(5);
  });

  it("flags uncertain tiles in the tooltip", () => {
    const { container } = renderTypes();
    hover(container, 34, 350);
    expect(container.querySelector(".tip-low")!.textContent).toBe("uncertain");
  });
});

describe("SpatialPlot Tissue view — cancer probability", () => {
  it("shows a probability scale instead of class pills and reports P(cancer) on hover", () => {
    const { container } = render(
      <SpatialPlot pred={toPrediction(TISSUE_RESPONSE)} ready view="tissue" gene="ERBB2" tissueMode="cancer" />,
    );
    expect(screen.getByText("predicted probability of cancer")).toBeTruthy();
    expect(container.querySelector(".tissue-legend")).toBeNull();
    hover(container, 34, 10);
    expect(container.querySelector(".tip-cancer")!.textContent).toBe("Cancer probability 90.0%");
  });
});

describe("predictions without tissue data, and the Genes view", () => {
  it("renders an old prediction with no tissue UI", () => {
    const { container } = render(<SpatialPlot pred={toPrediction(OLD_RESPONSE)} ready view="tissue" gene="ERBB2" />);
    expect(container.querySelector(".tissue-legend")).toBeNull();
    hover(container, 34, 10);
    expect(container.querySelector(".tip-tissue")).toBeNull();
  });

  it("keeps the Genes view unchanged even when tissue data exists", () => {
    const { container } = render(<SpatialPlot pred={toPrediction(TISSUE_RESPONSE)} ready view="genes" gene="ERBB2" />);
    expect(container.querySelector(".vbar")).not.toBeNull();
    expect(container.querySelector(".tissue-status")).toBeNull();
    hover(container, 34, 10);
    expect(container.querySelector(".tip-tissue")).toBeNull();
  });
});

describe("TissueInsights", () => {
  it("opens on expression by tissue type for the selected gene", () => {
    render(<TissueInsights pred={toPrediction(TISSUE_RESPONSE)} gene="ERBB2" onPickGene={() => {}} />);
    expect(screen.getByRole("tab", { name: "Expression by tissue type" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { level: 4, name: "ERBB2 by tissue type" })).toBeTruthy();
    const cancerRow = screen.getAllByText("Cancer")[0].closest(".insight-row")!;
    expect(cancerRow.textContent).toContain("2.00");
    expect(cancerRow.textContent).toContain("n=3");
  });

  it("lists genes highest in Cancer tiles and lets one be picked", () => {
    const onPickGene = vi.fn();
    render(<TissueInsights pred={toPrediction(TISSUE_RESPONSE)} gene="CD74" onPickGene={onPickGene} />);
    const row = screen.getByRole("button", { name: "ERBB2" }).closest("tr")!;
    expect(row.textContent).toContain("+0.50");
    fireEvent.click(screen.getByRole("button", { name: "ERBB2" }));
    expect(onPickGene).toHaveBeenCalledWith("ERBB2");
  });

  it("switches to composition: cancer area, stacked bar and cluster table", () => {
    render(<TissueInsights pred={toPrediction(TISSUE_RESPONSE)} gene="ERBB2" onPickGene={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: "Composition" }));
    expect(screen.getByText(/Cancer area:/).textContent).toBe("Cancer area: 75.0% of tiles");
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("Adipose tissue 25.0%");
    expect(screen.getByText("Expression cluster")).toBeTruthy();
  });
});
