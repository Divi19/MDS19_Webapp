"use client";

import { useMemo, useState } from "react";
import { analyzePathways, analyzeROI } from "@/lib/api";
import type {
  PathwayResponse,
  PredictionResponse,
  ROIAnalysisResponse,
} from "@/lib/types";
import type { ROIGroup } from "./SpatialPlot";

export type WorkspaceTab = "overview" | "genes" | "domains" | "roi" | "compare" | "methods";

function numberValue(value: number | null | undefined, digits = 5) {
  return value == null || !Number.isFinite(value) ? "—" : value.toPrecision(digits);
}

function percentValue(value: number | null | undefined) {
  return value == null || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(2)}%`;
}

function isExpandedPrediction(value: unknown): value is PredictionResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PredictionResponse>;
  return Boolean(
    candidate.prediction_id &&
      Array.isArray(candidate.prediction_tiles) &&
      candidate.model_metadata &&
      candidate.image_metadata &&
      candidate.coordinate_metadata &&
      candidate.qc &&
      candidate.applicability &&
      candidate.all_gene_summary,
  );
}

function WarningList({ items }: { items: string[] }) {
  if (!items.length) return <div className="quiet-state">No warnings returned.</div>;
  return <ul className="warning-list">{items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>;
}

export default function ScientificPanels({
  activeTab,
  prediction,
  gene,
  onGeneChange,
  selectedA,
  selectedB,
  activeROIGroup,
  onActiveROIGroupChange,
  onClearROI,
}: {
  activeTab: WorkspaceTab;
  prediction: PredictionResponse;
  gene: string;
  onGeneChange: (gene: string) => void;
  selectedA: number[];
  selectedB: number[];
  activeROIGroup: ROIGroup | null;
  onActiveROIGroupChange: (group: ROIGroup | null) => void;
  onClearROI: () => void;
}) {
  const [geneQuery, setGeneQuery] = useState("");
  const [roiResult, setROIResult] = useState<ROIAnalysisResponse | null>(null);
  const [roiError, setROIError] = useState("");
  const [roiRunning, setROIRunning] = useState(false);
  const [comparePrediction, setComparePrediction] = useState<PredictionResponse | null>(null);
  const [compareName, setCompareName] = useState("");
  const [compareError, setCompareError] = useState("");
  const [pathwayGenes, setPathwayGenes] = useState(() => prediction.top_genes.slice(0, 10).map((item) => item.gene_name).join(", "));
  const [pathways, setPathways] = useState<PathwayResponse | null>(null);
  const [pathwayError, setPathwayError] = useState("");
  const [pathwayRunning, setPathwayRunning] = useState(false);

  const spatialByGene = useMemo(
    () => new Map(prediction.spatial_statistics?.genes.map((item) => [item.gene_name, item]) ?? []),
    [prediction.spatial_statistics],
  );
  const rankingByGene = useMemo(
    () => new Map(prediction.top_genes.map((item) => [item.gene_name, item])),
    [prediction.top_genes],
  );
  const geneRows = useMemo(() => {
    const query = geneQuery.trim().toLowerCase();
    return prediction.all_gene_summary.genes.filter((item) => item.gene_name.toLowerCase().includes(query));
  }, [geneQuery, prediction.all_gene_summary.genes]);

  async function runROI() {
    setROIRunning(true);
    setROIError("");
    try {
      const result = await analyzeROI({
        prediction_tiles: prediction.prediction_tiles,
        group_a_tile_indices: selectedA,
        group_b_tile_indices: selectedB,
        permutations: 99,
        seed: 19,
      });
      setROIResult(result);
    } catch (error) {
      setROIError(error instanceof Error ? error.message : "ROI analysis failed");
    } finally {
      setROIRunning(false);
    }
  }

  async function loadComparison(file: File | undefined) {
    if (!file) return;
    setCompareError("");
    setComparePrediction(null);
    setCompareName(file.name);
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      if (!isExpandedPrediction(parsed)) throw new Error("This file is not an expanded PredictionResponse JSON.");
      const reasons: string[] = [];
      if (parsed.model_metadata.panel_size !== prediction.model_metadata.panel_size) reasons.push("panel size differs");
      if (parsed.model_metadata.reference_scope !== prediction.model_metadata.reference_scope) reasons.push("reference scope differs");
      if (parsed.model_metadata.output_type !== prediction.model_metadata.output_type) reasons.push("output type differs");
      if (reasons.length) throw new Error(`Comparison is incompatible: ${reasons.join("; ")}.`);
      setComparePrediction(parsed);
    } catch (error) {
      setCompareError(error instanceof Error ? error.message : "Could not read comparison JSON");
    }
  }

  async function runPathways() {
    const genes = pathwayGenes.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
    setPathwayRunning(true);
    setPathwayError("");
    try {
      setPathways(await analyzePathways({ genes }));
    } catch (error) {
      setPathwayError(error instanceof Error ? error.message : "Pathway analysis failed");
    } finally {
      setPathwayRunning(false);
    }
  }

  const comparison = useMemo(() => {
    if (!comparePrediction) return null;
    const secondGenes = new Map(comparePrediction.all_gene_summary.genes.map((item) => [item.gene_name, item]));
    const genes = prediction.all_gene_summary.genes
      .flatMap((item) => {
        const second = secondGenes.get(item.gene_name);
        return second ? [{ gene: item.gene_name, primary: item.mean_expression, comparison: second.mean_expression, difference: item.mean_expression - second.mean_expression }] : [];
      })
      .sort((first, second) => Math.abs(second.difference) - Math.abs(first.difference));
    const primaryTotal = prediction.domain_summaries.reduce((sum, item) => sum + item.tile_count, 0);
    const comparisonTotal = comparePrediction.domain_summaries.reduce((sum, item) => sum + item.tile_count, 0);
    const domainIds = Array.from(new Set([...prediction.domain_summaries.map((item) => item.domain_id), ...comparePrediction.domain_summaries.map((item) => item.domain_id)])).sort();
    return {
      genes,
      domains: domainIds.map((domainId) => {
        const primary = prediction.domain_summaries.find((item) => item.domain_id === domainId)?.tile_count ?? 0;
        const secondary = comparePrediction.domain_summaries.find((item) => item.domain_id === domainId)?.tile_count ?? 0;
        return { domainId, primary: primaryTotal ? primary / primaryTotal : 0, comparison: comparisonTotal ? secondary / comparisonTotal : 0 };
      }),
    };
  }, [comparePrediction, prediction.all_gene_summary.genes, prediction.domain_summaries]);

  if (activeTab === "overview") {
    const qc = prediction.qc;
    return (
      <div className="scientific-panel-grid">
        <section className="science-card wide">
          <div className="science-card-heading"><div><span>Run overview</span><h2>Prediction tiles and scope</h2></div><span className={`scope-status ${prediction.applicability.within_reference_scope ? "in" : "out"}`}>{prediction.applicability.within_reference_scope ? "Within reference scope" : "Outside reference scope"}</span></div>
          <div className="overview-metrics">
            <div><span>Prediction tiles</span><strong>{prediction.prediction_tiles.length}</strong></div>
            <div><span>Panel size</span><strong>{prediction.model_metadata.panel_size}</strong></div>
            <div><span>Image</span><strong>{prediction.image_metadata.width_pixels} × {prediction.image_metadata.height_pixels}</strong></div>
            <div><span>Microns per pixel</span><strong>{numberValue(prediction.image_metadata.microns_per_pixel)}</strong></div>
          </div>
          <dl className="definition-grid">
            <div><dt>Reference scope</dt><dd>{prediction.applicability.reference_scope}</dd></div>
            <div><dt>HER2-positive breast tissue confirmed</dt><dd>{String(prediction.applicability.her2_positive_breast_tissue_confirmed)}</dd></div>
            <div><dt>H&amp;E confirmed</dt><dd>{String(prediction.applicability.he_stain_confirmed)}</dd></div>
            <div><dt>Created</dt><dd>{new Date(prediction.created_at).toLocaleString()}</dd></div>
          </dl>
        </section>
        <section className="science-card">
          <div className="section-kicker">Image QC</div>
          <div className="qc-grid">
            <div><span>Tissue fraction</span><strong>{numberValue(qc.tissue_fraction)}</strong></div>
            <div><span>Brightness</span><strong>{numberValue(qc.brightness)}</strong></div>
            <div><span>Contrast</span><strong>{numberValue(qc.contrast)}</strong></div>
            <div><span>Mean saturation</span><strong>{numberValue(qc.mean_saturation)}</strong></div>
            <div><span>Focus proxy</span><strong>{numberValue(qc.focus_proxy)}</strong></div>
            <div><span>Accepted tiles</span><strong>{qc.accepted_tile_count}</strong></div>
            <div><span>Rejected tiles</span><strong>{qc.rejected_tile_count}</strong></div>
          </div>
        </section>
        <section className="science-card">
          <div className="section-kicker">Warnings</div>
          <WarningList items={[...prediction.warnings, ...prediction.qc.warnings, ...prediction.analysis_warnings]} />
        </section>
      </div>
    );
  }

  if (activeTab === "genes") {
    return (
      <div className="scientific-panel-grid">
        <section className="science-card wide">
          <div className="table-tools"><div><span className="section-kicker">Authoritative panel summary</span><h2>Model-scale predicted expression</h2></div><input value={geneQuery} onChange={(event) => setGeneQuery(event.target.value)} placeholder="Filter gene" aria-label="Filter genes" /></div>
          <div className="table-scroll">
            <table className="science-table">
              <thead><tr><th>Gene</th><th>Mean</th><th>Variance</th><th>Rank</th><th>Moran&apos;s I</th><th>Empirical p</th><th>q</th></tr></thead>
              <tbody>{geneRows.map((item) => {
                const spatial = spatialByGene.get(item.gene_name);
                return <tr key={item.gene_name} className={gene === item.gene_name ? "selected" : ""} onClick={() => onGeneChange(item.gene_name)}><td><button>{item.gene_name}</button></td><td>{numberValue(item.mean_expression)}</td><td>{numberValue(item.variance_expression)}</td><td>{rankingByGene.get(item.gene_name)?.rank ?? "—"}</td><td>{numberValue(spatial?.morans_i)}</td><td>{numberValue(spatial?.empirical_p_value)}</td><td>{numberValue(spatial?.q_value)}</td></tr>;
              })}</tbody>
            </table>
          </div>
          <div className="table-foot">{geneRows.length} genes · raw backend values · click a row to update the overlay</div>
        </section>
        <section className="science-card wide pathway-card">
          <div><span className="section-kicker">Optional backend annotation</span><h2>Pathway request</h2></div>
          <div className="inline-request"><input value={pathwayGenes} onChange={(event) => setPathwayGenes(event.target.value)} aria-label="Genes for pathway request" /><button onClick={runPathways} disabled={pathwayRunning}>{pathwayRunning ? "Requesting…" : "Request pathways"}</button></div>
          {pathwayError && <div className="inline-error">{pathwayError}</div>}
          {pathways && <div className="table-scroll compact"><table className="science-table"><thead><tr><th>Source</th><th>Term</th><th>Adjusted p</th><th>Contributing genes</th></tr></thead><tbody>{pathways.terms.map((term) => <tr key={`${term.source}-${term.term_id}`}><td>{term.source}</td><td>{term.term_name}<small>{term.term_id}</small></td><td>{numberValue(term.adjusted_p_value)}</td><td>{term.contributing_genes.join(", ")}</td></tr>)}</tbody></table></div>}
          {pathways && <WarningList items={pathways.warnings} />}
        </section>
      </div>
    );
  }

  if (activeTab === "domains") {
    return (
      <div className="scientific-panel-grid">
        {prediction.domain_summaries.length ? prediction.domain_summaries.map((domain) => (
          <section className="science-card" key={domain.domain_id}>
            <div className="domain-heading"><div><span className="section-kicker">{domain.label}</span><h2>{domain.domain_id}</h2></div><strong>{domain.tile_count} tiles</strong></div>
            <div className="table-scroll compact"><table className="science-table"><thead><tr><th>Marker</th><th>Effect</th><th>q</th><th>Domain mean</th><th>Rest mean</th></tr></thead><tbody>{domain.markers.map((marker) => <tr key={marker.gene_name}><td>{marker.gene_name}</td><td>{numberValue(marker.effect_size)}</td><td>{numberValue(marker.q_value)}</td><td>{numberValue(marker.domain_mean)}</td><td>{numberValue(marker.rest_mean)}</td></tr>)}</tbody></table></div>
          </section>
        )) : <section className="science-card wide"><div className="quiet-state">No backend predicted-expression domains were returned.</div></section>}
      </div>
    );
  }

  if (activeTab === "roi") {
    return (
      <div className="scientific-panel-grid">
        <section className="science-card wide">
          <div className="science-card-heading"><div><span className="section-kicker">Explicit prediction tile groups</span><h2>Exploratory ROI comparison</h2></div><button className="text-button" onClick={onClearROI}>Clear groups</button></div>
          <p className="panel-copy">Choose group A or B, then click prediction tiles in the viewer. A tile can belong to only one group.</p>
          <div className="roi-controls">
            <button className={activeROIGroup === "A" ? "group-a active" : "group-a"} onClick={() => onActiveROIGroupChange(activeROIGroup === "A" ? null : "A")}>Select group A <strong>{selectedA.length}</strong></button>
            <button className={activeROIGroup === "B" ? "group-b active" : "group-b"} onClick={() => onActiveROIGroupChange(activeROIGroup === "B" ? null : "B")}>Select group B <strong>{selectedB.length}</strong></button>
            <button className="primary-action" disabled={!selectedA.length || !selectedB.length || roiRunning} onClick={runROI}>{roiRunning ? "Running…" : "Run ROI API"}</button>
          </div>
          {roiError && <div className="inline-error">{roiError}</div>}
        </section>
        {roiResult && <section className="science-card wide"><div className="result-heading"><div><span className="section-kicker">{roiResult.label}</span><h2>{roiResult.group_a_size} A tiles vs {roiResult.group_b_size} B tiles</h2></div><span>{roiResult.permutation_method} · {roiResult.permutations} permutations · seed {roiResult.seed}</span></div><div className="table-scroll"><table className="science-table"><thead><tr><th>Gene</th><th>A mean</th><th>B mean</th><th>Difference</th><th>Effect</th><th>Permutation p</th><th>q</th></tr></thead><tbody>{roiResult.genes.map((item) => <tr key={item.gene_name}><td>{item.gene_name}</td><td>{numberValue(item.group_a_mean)}</td><td>{numberValue(item.group_b_mean)}</td><td>{numberValue(item.mean_difference)}</td><td>{numberValue(item.effect_size)}</td><td>{numberValue(item.permutation_p_value)}</td><td>{numberValue(item.q_value)}</td></tr>)}</tbody></table></div><WarningList items={roiResult.warnings} /></section>}
      </div>
    );
  }

  if (activeTab === "compare") {
    return (
      <div className="scientific-panel-grid">
        <section className="science-card wide">
          <div className="science-card-heading"><div><span className="section-kicker">Local expanded response</span><h2>Compare two prediction runs</h2></div><label className="file-button">Load PredictionResponse JSON<input type="file" accept="application/json,.json" onChange={(event) => loadComparison(event.target.files?.[0])} /></label></div>
          <p className="panel-copy">Compatibility requires the same panel size, reference scope, and prediction tile output type. The file remains in this browser session.</p>
          {compareName && <div className="loaded-file">{compareName}</div>}
          {compareError && <div className="inline-error">{compareError}</div>}
        </section>
        {comparePrediction && comparison && <>
          <section className="science-card wide"><div className="section-kicker">Gene means</div><div className="table-scroll"><table className="science-table"><thead><tr><th>Gene</th><th>Current</th><th>Comparison</th><th>Difference</th></tr></thead><tbody>{comparison.genes.slice(0, 100).map((item) => <tr key={item.gene}><td>{item.gene}</td><td>{numberValue(item.primary)}</td><td>{numberValue(item.comparison)}</td><td>{numberValue(item.difference)}</td></tr>)}</tbody></table></div></section>
          <section className="science-card"><div className="section-kicker">QC side by side</div><table className="science-table"><thead><tr><th>Value</th><th>Current</th><th>Comparison</th></tr></thead><tbody><tr><td>Tissue fraction</td><td>{numberValue(prediction.qc.tissue_fraction)}</td><td>{numberValue(comparePrediction.qc.tissue_fraction)}</td></tr><tr><td>Brightness</td><td>{numberValue(prediction.qc.brightness)}</td><td>{numberValue(comparePrediction.qc.brightness)}</td></tr><tr><td>Contrast</td><td>{numberValue(prediction.qc.contrast)}</td><td>{numberValue(comparePrediction.qc.contrast)}</td></tr><tr><td>Focus proxy</td><td>{numberValue(prediction.qc.focus_proxy)}</td><td>{numberValue(comparePrediction.qc.focus_proxy)}</td></tr></tbody></table></section>
          <section className="science-card"><div className="section-kicker">Domain fractions</div><table className="science-table"><thead><tr><th>Domain</th><th>Current</th><th>Comparison</th></tr></thead><tbody>{comparison.domains.map((item) => <tr key={item.domainId}><td>{item.domainId}</td><td>{percentValue(item.primary)}</td><td>{percentValue(item.comparison)}</td></tr>)}</tbody></table></section>
        </>}
      </div>
    );
  }

  const method = prediction.analysis_method;
  return (
    <div className="scientific-panel-grid">
      <section className="science-card"><div className="section-kicker">Model</div><dl className="stacked-definitions"><div><dt>Mode</dt><dd>{prediction.model_metadata.mode}</dd></div><div><dt>Version</dt><dd>{prediction.model_metadata.model_version}</dd></div><div><dt>Reference scope</dt><dd>{prediction.model_metadata.reference_scope}</dd></div><div><dt>Output</dt><dd>{prediction.model_metadata.output_type}</dd></div><div><dt>Panel size</dt><dd>{prediction.model_metadata.panel_size}</dd></div></dl></section>
      <section className="science-card"><div className="section-kicker">Retrieval</div><dl className="stacked-definitions"><div><dt>Label</dt><dd>{prediction.model_metadata.retrieval_support_label ?? "—"}</dd></div><div><dt>Neighbor selection</dt><dd>{prediction.model_metadata.retrieval_neighbor_selection ?? "—"}</dd></div><div><dt>Weighting</dt><dd>{prediction.model_metadata.retrieval_weighting ?? "—"}</dd></div></dl></section>
      <section className="science-card"><div className="section-kicker">Expression</div><dl className="stacked-definitions"><div><dt>Output language</dt><dd>model-scale predicted expression</dd></div><div><dt>Summary authoritative</dt><dd>{String(prediction.all_gene_summary.authoritative)}</dd></div><div><dt>Statistics</dt><dd>{prediction.all_gene_summary.statistics.join(", ")}</dd></div></dl></section>
      <section className="science-card"><div className="section-kicker">Coordinates</div><dl className="stacked-definitions"><div><dt>Centers</dt><dd>{prediction.coordinate_metadata.x_y_units}</dd></div><div><dt>Bounds</dt><dd>{prediction.coordinate_metadata.bounds_units}</dd></div><div><dt>Origin</dt><dd>{prediction.coordinate_metadata.origin}</dd></div><div><dt>Semantics</dt><dd>{prediction.coordinate_metadata.x_y_semantics}</dd></div></dl></section>
      <section className="science-card wide"><div className="section-kicker">Analysis</div>{method ? <dl className="definition-grid"><div><dt>Result</dt><dd>{method.result_type}</dd></div><div><dt>Variable gene selection</dt><dd>{method.variable_gene_selection} · limit {method.variable_gene_limit}</dd></div><div><dt>Standardization</dt><dd>{method.standardization}</dd></div><div><dt>PCA solver</dt><dd>{method.pca_solver}</dd></div><div><dt>K-means</dt><dd>requested {method.kmeans_requested_k} · fitted {method.kmeans_fitted_k} · seed {method.kmeans_seed} · n_init {method.kmeans_n_init} · {method.kmeans_algorithm}</dd></div><div><dt>Marker analysis</dt><dd>{method.marker_effect_size} · {method.marker_test}</dd></div><div><dt>Silhouette</dt><dd>{numberValue(method.silhouette)}</dd></div><div><dt>Variable genes</dt><dd>{method.variable_genes.join(", ")}</dd></div></dl> : <div className="quiet-state">No backend analysis method metadata was returned.</div>}</section>
    </div>
  );
}
