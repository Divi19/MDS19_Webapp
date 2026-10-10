import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { toPrediction } from "@/lib/api";
import { clusteredLargePrediction, LARGE_TISSUE_RESPONSE, OLD_RESPONSE, TISSUE_RESPONSE } from "@/test/fixtures";
import SpatialPlot from "./SpatialPlot";
import TissueAnalysisPanel from "./TissueAnalysisPanel";
import TissueBreakdown from "./TissueBreakdown";
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
    // Raw predicted expression, matching the Tissue Analysis panel.
    expect(tip.textContent).toContain("ERBB2 1.00");
    expect(tip.textContent).not.toContain("Cancer probability");
  });

  it("flags uncertain tiles in the tooltip", () => {
    const { container } = renderTypes();
    hover(container, 34, 350);
    expect(container.querySelector(".tip-low")!.textContent).toBe("uncertain");
  });
});

describe("SpatialPlot Tissue view — pinning", () => {
  it("pins a type from the legend, shows the gene's range within it, and unpins", () => {
    const onTissuePin = vi.fn();
    const { container, rerender } = render(
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
    // Pinned: the pills give way to the pinned type and the selected gene's
    // range within it (raw ERBB2 in the three Cancer tiles: 1.0, 2.0, 3.0).
    expect(container.querySelector(".tissue-legend")).toBeNull();
    expect(container.querySelector(".tgs")!.textContent).toBe("ERBB21.003.00");
    fireEvent.click(screen.getByRole("button", { name: "Unpin Cancer" }));
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
    // A table: headers name the groups, so no "a vs b" text is needed.
    const table = screen.getByRole("table", { name: "Genes higher in Cancer than Other tiles" });
    expect([...table.querySelectorAll('[role="columnheader"]')].map((h) => h.textContent)).toEqual([
      "Gene",
      "Cancer",
      "Other tiles",
      "Diff.",
    ]);
    const cells = [...screen.getByRole("row", { name: "ERBB2" }).querySelectorAll("span")].map((c) => c.textContent);
    expect(cells[0]).toBe("ERBB2");
    expect(cells[1]).toBe("2.10");
    expect(screen.queryByRole("row", { name: "CD74" })).toBeNull();
    fireEvent.click(screen.getByRole("row", { name: "ERBB2" }));
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

describe("TissueComposition (Composition tab)", () => {
  it("shows the whole section and each cluster with its tissue types written out", () => {
    render(<TissueComposition pred={toPrediction(TISSUE_RESPONSE)} />);
    const bars = screen.getAllByRole("img");
    expect(bars[0].getAttribute("aria-label")).toContain("Cancer 75.0%");
    expect(bars[0].getAttribute("aria-label")).toContain("Adipose tissue 25.0%");
    expect(screen.getByText("All tiles")).toBeTruthy();
    expect(screen.getByText("Cancer 75% · Adipose 25%")).toBeTruthy();
    expect(screen.queryByText(/Cancer-classified/)).toBeNull();
  });

  it("names each cluster, counts its tile types and highlights it on hover", () => {
    const onHoverCluster = vi.fn();
    const { container } = render(<TissueComposition pred={clusteredLargePrediction()} onHoverCluster={onHoverCluster} />);
    expect(screen.getByText("Cancer (100%)")).toBeTruthy();
    expect(screen.getByText("10 Cancer · 8 Connective")).toBeTruthy();
    // Empty clusters 3 and 4 are left out.
    expect(container.querySelectorAll(".composition-row:not(.overall)")).toHaveLength(3);
    const row = screen.getByText("10 Cancer · 8 Connective").closest("section")!;
    fireEvent.mouseEnter(row);
    expect(onHoverCluster).toHaveBeenLastCalledWith(1);
    fireEvent.mouseLeave(row);
    expect(onHoverCluster).toHaveBeenLastCalledWith(null);
  });
});

describe("cluster tissue names", () => {
  it("shows the short tissue name in the Clusters legend, full name on hover", () => {
    const { container } = render(<SpatialPlot pred={clusteredLargePrediction()} ready view="clusters" gene="ERBB2" />);
    const items = [...container.querySelectorAll(".legend .legend-item .legend-name")].map((e) => e.textContent);
    expect(items.slice(0, 3)).toEqual(["0 · Cancer", "1 · Mixed", "2 · Connective"]);
    expect(items[3]).toBe("cluster 3");
    expect(container.querySelector(".legend .legend-item")!.getAttribute("title")).toBe("cluster 0 · Cancer (100%)");
  });
});

describe("TissueAnalysisPanel — expression groups within a type", () => {
  it("lists the clusters a type falls into and highlights a group on hover", () => {
    const onHoverGroup = vi.fn();
    render(
      <TissueAnalysisPanel pred={clusteredLargePrediction()} gene="ERBB2" onPickGene={() => {}} onHoverGroup={onHoverGroup} />,
    );
    expect(screen.getByRole("heading", { level: 4, name: "Expression groups within Cancer" })).toBeTruthy();
    const row = screen.getByTitle("10 Cancer tiles in cluster 0 · Cancer (100%)");
    expect(row.textContent).toContain("10 tiles");
    expect(screen.getByTitle("10 Cancer tiles in cluster 1 · Cancer + Connective")).toBeTruthy();
    fireEvent.mouseEnter(row);
    expect(onHoverGroup).toHaveBeenLastCalledWith({ cls: "Cancer", cluster: 0 });
    fireEvent.mouseLeave(row);
    expect(onHoverGroup).toHaveBeenLastCalledWith(null);
  });

  it("lists the genes that differ between the two largest groups", () => {
    const onPickGene = vi.fn();
    render(<TissueAnalysisPanel pred={clusteredLargePrediction()} gene="ERBB2" onPickGene={onPickGene} />);
    expect(screen.getByText("No genes clearly higher in cluster 0.")).toBeTruthy();
    const table = screen.getByRole("table", { name: "Genes higher in Cluster 1 than Cluster 0" });
    expect(table.textContent).toContain("LTF");
    expect(table.textContent).toContain("+1.00");
    fireEvent.click(within(table).getByRole("row", { name: "LTF" }));
    expect(onPickGene).toHaveBeenCalledWith("LTF");
  });

  it("says so when only one cluster holds 10+ tiles of the type", () => {
    const pred = clusteredLargePrediction();
    const single = { ...pred, spots: pred.spots.map((s) => (s.tissue?.cls === "Cancer" ? { ...s, cluster: 0 } : s)) };
    render(<TissueAnalysisPanel pred={single} gene="ERBB2" onPickGene={() => {}} />);
    expect(screen.getByText(/Only one cluster has 10 or more Cancer tiles/)).toBeTruthy();
    expect(screen.queryByText(/^Higher in cluster/)).toBeNull();
    expect(screen.queryByRole("table", { name: /Cluster/ })).toBeNull();
  });
});

describe("TissueBreakdown (Tissue tab bottom card)", () => {
  it("shows one tile per tissue type with count and share, flagging types with too few tiles", () => {
    render(<TissueBreakdown pred={toPrediction(LARGE_TISSUE_RESPONSE)} />);
    const cancer = screen.getByRole("button", { name: /Cancer/ });
    expect(cancer.textContent).toBe("Cancer2057.1%");
    const adipose = screen.getByRole("button", { name: /Adipose/ });
    expect(adipose.textContent).toBe("Adipose38.6% · too few");
    expect(adipose.className).toContain("few");
    expect(screen.getAllByRole("button")).toHaveLength(5);
  });

  it("pins and unpins a type on click", () => {
    const onPin = vi.fn();
    const pred = toPrediction(LARGE_TISSUE_RESPONSE);
    const { rerender } = render(<TissueBreakdown pred={pred} onPin={onPin} />);
    fireEvent.click(screen.getByRole("button", { name: /Connective/ }));
    expect(onPin).toHaveBeenLastCalledWith("Connective tissue");
    rerender(<TissueBreakdown pred={pred} pinned="Connective tissue" onPin={onPin} />);
    const tile = screen.getByRole("button", { name: /Connective/ });
    expect(tile.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(tile);
    expect(onPin).toHaveBeenLastCalledWith(null);
  });
});

describe("TissueAnalysisPanel tabs", () => {
  it("switches between Expression and Composition, clearing hover highlights", () => {
    const onHoverType = vi.fn();
    render(
      <TissueAnalysisPanel pred={clusteredLargePrediction()} gene="ERBB2" onPickGene={() => {}} onHoverType={onHoverType} />,
    );
    expect(screen.getByRole("tab", { name: "Expression" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { level: 4, name: "ERBB2 by tissue type" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Composition" }));
    expect(onHoverType).toHaveBeenLastCalledWith(null);
    expect(screen.queryByRole("heading", { level: 4, name: "ERBB2 by tissue type" })).toBeNull();
    expect(screen.getByText("All tiles")).toBeTruthy();
  });
});

describe("click to lock", () => {
  it("locks a tissue type from the gene-by-type rows and fades the others", () => {
    const onPin = vi.fn();
    const pred = toPrediction(LARGE_TISSUE_RESPONSE);
    const { rerender } = render(<TissueAnalysisPanel pred={pred} gene="ERBB2" onPickGene={() => {}} onPin={onPin} />);
    fireEvent.click(screen.getByTitle(/^Connective tissue: 12 tiles/));
    expect(onPin).toHaveBeenLastCalledWith("Connective tissue");

    rerender(<TissueAnalysisPanel pred={pred} gene="ERBB2" onPickGene={() => {}} pinned="Connective tissue" onPin={onPin} />);
    const locked = screen.getByTitle(/^Connective tissue: 12 tiles/);
    expect(locked.className).toContain("pinned");
    expect(locked.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTitle(/^Cancer: 20 tiles/).className).toContain("dimmed");
    fireEvent.click(locked);
    expect(onPin).toHaveBeenLastCalledWith(null);
  });

  it("locks a cluster from the Composition cards and fades the others", () => {
    const onPinCluster = vi.fn();
    const pred = clusteredLargePrediction();
    const { rerender } = render(<TissueComposition pred={pred} onPinCluster={onPinCluster} />);
    const card = () => screen.getByText("10 Cancer · 8 Connective").closest("section")!;
    fireEvent.click(card());
    expect(onPinCluster).toHaveBeenLastCalledWith(1);

    rerender(<TissueComposition pred={pred} pinnedCluster={1} onPinCluster={onPinCluster} />);
    expect(card().className).toContain("pinned");
    expect(screen.getByText("10 Cancer").closest("section")!.className).toContain("dimmed");
    fireEvent.click(card());
    expect(onPinCluster).toHaveBeenLastCalledWith(null);
  });

  it("releases a cluster lock when leaving the Composition tab", () => {
    const onPinCluster = vi.fn();
    render(
      <TissueAnalysisPanel
        pred={clusteredLargePrediction()}
        gene="ERBB2"
        onPickGene={() => {}}
        pinnedCluster={1}
        onPinCluster={onPinCluster}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Composition" }));
    expect(onPinCluster).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "Expression" }));
    expect(onPinCluster).toHaveBeenLastCalledWith(null);
  });
});
