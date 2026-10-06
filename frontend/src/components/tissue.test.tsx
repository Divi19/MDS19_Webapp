import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { toPrediction } from "@/lib/api";
import { LARGE_TISSUE_RESPONSE, OLD_RESPONSE, TISSUE_RESPONSE } from "@/test/fixtures";
import SpatialPlot from "./SpatialPlot";
import TissueAnalysisPanel from "./TissueAnalysisPanel";
import TissueComposition from "./TissueComposition";

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

describe("SpatialPlot Tissue view", () => {
  const renderTypes = () =>
    render(<SpatialPlot pred={toPrediction(TISSUE_RESPONSE)} ready view="tissue" gene="ERBB2" />);

  it("shows class pills with counts and percentages, and no confidence pill", () => {
    renderTypes();
    expect(screen.getByRole("button", { name: /Cancer\s*3 · 75\.0%/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Adipose tissue\s*1 · 25\.0%/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Immune infiltrate\s*0 · 0\.0%/ })).toBeTruthy();
    expect(screen.queryByText(/confidence </)).toBeNull();
  });

  it("shows no status text, disclaimer, uncertain-only filter or cancer-probability scale", () => {
    const { container } = renderTypes();
    expect(container.querySelector(".tissue-status")).toBeNull();
    expect(screen.queryByText("P(cancer)")).toBeNull();
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
    expect(tip.textContent).not.toContain("Cancer probability");
  });

  it("flags uncertain tiles in the tooltip", () => {
    const { container } = renderTypes();
    hover(container, 34, 350);
    expect(container.querySelector(".tip-low")!.textContent).toBe("uncertain");
  });
});

describe("SpatialPlot Tissue view — pinning", () => {
  it("pins and unpins a tissue type from the legend", () => {
    const onTissuePin = vi.fn();
    const { rerender } = render(
      <SpatialPlot pred={toPrediction(TISSUE_RESPONSE)} ready view="tissue" gene="ERBB2" onTissuePin={onTissuePin} />,
    );
    const cancer = screen.getByRole("button", { name: /^Cancer\s*3/ });
    expect(cancer.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(cancer);
    expect(onTissuePin).toHaveBeenLastCalledWith("Cancer");

    rerender(
      <SpatialPlot
        pred={toPrediction(TISSUE_RESPONSE)}
        ready
        view="tissue"
        gene="ERBB2"
        tissuePin="Cancer"
        onTissuePin={onTissuePin}
      />,
    );
    const pinned = screen.getByRole("button", { name: /^Cancer\s*3/ });
    expect(pinned.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(pinned);
    expect(onTissuePin).toHaveBeenLastCalledWith(null);
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

describe("TissueAnalysisPanel", () => {
  it("shows the selected gene's mean and spread for types with enough tiles", () => {
    const { container } = render(
      <TissueAnalysisPanel pred={toPrediction(LARGE_TISSUE_RESPONSE)} gene="ERBB2" onPickGene={() => {}} />,
    );
    expect(screen.getByRole("heading", { level: 4, name: "ERBB2 by tissue type" })).toBeTruthy();
    const cancerRow = screen.getByTitle(/^Cancer: 20 tiles · mean 2\.10 · middle half 2\.05–2\.15$/);
    expect(cancerRow.textContent).toContain("2.10");
    expect(cancerRow.textContent).toContain("n=20");
    expect(container.querySelectorAll(".ta-range")).toHaveLength(2);
  });

  it("greys out types with fewer than 10 tiles instead of showing a mean", () => {
    render(<TissueAnalysisPanel pred={toPrediction(LARGE_TISSUE_RESPONSE)} gene="ERBB2" onPickGene={() => {}} />);
    const adipose = screen.getByTitle("Adipose tissue: 3 tiles · too few to compare");
    expect(adipose.className).toContain("few");
    expect(adipose.textContent).toContain("too few");
    expect(adipose.textContent).not.toContain("0.50");
  });

  it("lists genes clearly higher in Cancer and lets one be picked", () => {
    const onPickGene = vi.fn();
    render(<TissueAnalysisPanel pred={toPrediction(LARGE_TISSUE_RESPONSE)} gene="CD74" onPickGene={onPickGene} />);
    expect(screen.getByRole("heading", { level: 4, name: "Genes higher in Cancer" })).toBeTruthy();
    const row = screen.getByRole("button", { name: "ERBB2" }).closest(".ta-gene-row")!;
    expect(row.textContent).toContain("2.10 vs");
    expect(screen.queryByRole("button", { name: "CD74" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "ERBB2" }));
    expect(onPickGene).toHaveBeenCalledWith("ERBB2");
  });

  it("offers only types with enough tiles and says so when nothing is clearly higher", () => {
    render(<TissueAnalysisPanel pred={toPrediction(LARGE_TISSUE_RESPONSE)} gene="ERBB2" onPickGene={() => {}} />);
    const picker = screen.getByRole("group", { name: "Tissue type" });
    expect([...picker.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Cancer", "Connective"]);
    fireEvent.click(screen.getByRole("button", { name: "Connective" }));
    expect(screen.getByText(/No genes clearly higher in Connective/)).toBeTruthy();
  });

  it("pins the picked type on the map and follows a pin made on the map", () => {
    const onPin = vi.fn();
    const pred = toPrediction(LARGE_TISSUE_RESPONSE);
    const { rerender } = render(<TissueAnalysisPanel pred={pred} gene="ERBB2" onPickGene={() => {}} onPin={onPin} />);
    fireEvent.click(screen.getByRole("button", { name: "Connective" }));
    expect(onPin).toHaveBeenLastCalledWith("Connective tissue");

    rerender(<TissueAnalysisPanel pred={pred} gene="ERBB2" onPickGene={() => {}} pinned="Cancer" onPin={onPin} />);
    expect(screen.getByRole("heading", { level: 4, name: "Genes higher in Cancer" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancer" }));
    expect(onPin).toHaveBeenLastCalledWith(null);
  });

  it("keeps its own pick when the pinned type is too small to compare", () => {
    render(
      <TissueAnalysisPanel pred={toPrediction(LARGE_TISSUE_RESPONSE)} gene="ERBB2" onPickGene={() => {}} pinned="Adipose tissue" />,
    );
    expect(screen.getByRole("heading", { level: 4, name: "Genes higher in Cancer" })).toBeTruthy();
  });

  it("reports the hovered tissue type so the map can highlight it", () => {
    const onHoverType = vi.fn();
    render(
      <TissueAnalysisPanel pred={toPrediction(LARGE_TISSUE_RESPONSE)} gene="ERBB2" onPickGene={() => {}} onHoverType={onHoverType} />,
    );
    const row = screen.getByTitle(/^Connective tissue: 12 tiles/);
    fireEvent.mouseEnter(row);
    expect(onHoverType).toHaveBeenLastCalledWith("Connective tissue");
    fireEvent.mouseLeave(row);
    expect(onHoverType).toHaveBeenLastCalledWith(null);
  });

  it("explains when no type has enough tiles to compare", () => {
    render(<TissueAnalysisPanel pred={toPrediction(TISSUE_RESPONSE)} gene="ERBB2" onPickGene={() => {}} />);
    expect(screen.queryByRole("group", { name: "Tissue type" })).toBeNull();
    expect(screen.getByText(/Needs a tissue type with at least 10 tiles/)).toBeTruthy();
  });
});

describe("TissueComposition", () => {
  it("shows whole-section and per-cluster stacked bars with a neutral tile count", () => {
    render(<TissueComposition pred={toPrediction(TISSUE_RESPONSE)} />);
    expect(screen.getByText("4 tiles classified")).toBeTruthy();
    expect(screen.queryByText(/Cancer-classified/)).toBeNull();
    const bars = screen.getAllByRole("img");
    expect(bars[0].getAttribute("aria-label")).toContain("Cancer 75.0%");
    expect(bars[0].getAttribute("aria-label")).toContain("Adipose tissue 25.0%");
    expect(bars).toHaveLength(1 + toPrediction(TISSUE_RESPONSE).counts.length);
    expect(screen.getByText("All tiles")).toBeTruthy();
  });
});
