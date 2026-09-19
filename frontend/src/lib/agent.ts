import type { DomainSummary, PredictionResponse } from "@/lib/types";

function raw(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "not returned" : String(value);
}

function geneInQuestion(question: string, prediction: PredictionResponse): string | null {
  const normalized = question.toUpperCase();
  const genes = prediction.all_gene_summary.genes
    .map((item) => item.gene_name)
    .sort((first, second) => second.length - first.length || first.localeCompare(second));
  return genes.find((gene) => {
    const escaped = gene.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^A-Z0-9])${escaped}([^A-Z0-9]|$)`).test(normalized);
  }) ?? null;
}

function domainInQuestion(question: string, prediction: PredictionResponse): DomainSummary | null {
  const normalized = question.toLowerCase();
  const exact = prediction.domain_summaries.find((domain) => normalized.includes(domain.domain_id.toLowerCase()));
  if (exact) return exact;
  const number = normalized.match(/domain[\s_-]*(\d+)/)?.[1];
  return number
    ? prediction.domain_summaries.find((domain) => domain.domain_id.toLowerCase() === `domain_${number}`) ?? null
    : null;
}

function answerQC(prediction: PredictionResponse): string {
  const qc = prediction.qc;
  const warningText = qc.warnings.length ? qc.warnings.join("; ") : "none returned";
  return `Calculated: QC returned tissue fraction ${raw(qc.tissue_fraction)}, brightness ${raw(qc.brightness)}, contrast ${raw(qc.contrast)}, mean saturation ${raw(qc.mean_saturation)}, focus proxy ${raw(qc.focus_proxy)}, ${qc.accepted_tile_count} accepted tiles, and ${qc.rejected_tile_count} rejected tiles.\nAnnotated: QC warnings: ${warningText}.\nAnnotated: The loaded request is ${prediction.applicability.within_reference_scope ? "marked within" : "marked outside"} the declared reference scope: ${prediction.applicability.reference_scope}. HER2-positive breast tissue confirmation: ${prediction.applicability.her2_positive_breast_tissue_confirmed ? "yes" : "no"}; H&E confirmation: ${prediction.applicability.he_stain_confirmed ? "yes" : "no"}.`;
}

function answerGene(gene: string, prediction: PredictionResponse): string {
  const candidates = prediction.prediction_tiles
    .flatMap((tile) => {
      const value = tile.expression[gene];
      return Number.isFinite(value) ? [{ tile, value }] : [];
    })
    .sort((first, second) => second.value - first.value || (first.tile.tile_index ?? first.tile.spot_index) - (second.tile.tile_index ?? second.tile.spot_index));
  const highest = candidates[0];
  if (!highest) return `Annotated: ${gene} is in the returned gene summary, but no finite tile-level predicted value was returned.`;
  const index = highest.tile.tile_index ?? highest.tile.spot_index;
  const bounds = highest.tile.bounds;
  const boundsText = bounds
    ? ` Bounds in ${prediction.coordinate_metadata.bounds_units}: left ${raw(bounds.left)}, top ${raw(bounds.top)}, right ${raw(bounds.right)}, bottom ${raw(bounds.bottom)}.`
    : " Tile bounds were not returned.";
  return `Predicted: ${gene} has its highest returned raw model-scale predicted value at tile ${index}: ${raw(highest.value)}.\nAnnotated: Returned position is (${raw(highest.tile.x)}, ${raw(highest.tile.y)}) in ${prediction.coordinate_metadata.x_y_units}.${boundsText}\nAnnotated: This locates a model prediction; it is not a measured assay value or biological interpretation.`;
}

function answerDomain(domain: DomainSummary): string {
  const markerLines = domain.markers.slice(0, 5).map(
    (marker) => `Calculated: ${marker.gene_name} rank ${marker.rank}, effect ${raw(marker.effect_size)}, q ${raw(marker.q_value)}, predicted domain mean ${raw(marker.domain_mean)}, predicted rest mean ${raw(marker.rest_mean)}.`,
  );
  const markers = markerLines.length ? markerLines.join("\n") : "Calculated: No marker contrasts were returned for this domain.";
  return `Calculated: ${domain.domain_id} contains ${domain.tile_count} tiles grouped as a ${domain.label}.\n${markers}\nAnnotated: These are contrasts of predicted values returned by the backend, not measured markers, cell types, or validated biomarkers.`;
}

function answerMethods(prediction: PredictionResponse): string {
  const metadata = prediction.model_metadata;
  const supports = prediction.prediction_tiles.flatMap((tile) => tile.retrieval_support ? [tile.retrieval_support] : []);
  const supportSummary = supports.length
    ? `Calculated: Retrieval support was returned for ${supports.length} of ${prediction.prediction_tiles.length} tiles. Mean of returned max selected cosine similarity values: ${raw(supports.reduce((sum, item) => sum + item.max_selected_cosine_similarity, 0) / supports.length)}; mean effective neighbor count: ${raw(supports.reduce((sum, item) => sum + item.effective_neighbor_count, 0) / supports.length)}.`
    : "Annotated: Tile-level retrieval support was not returned.";
  const analysis = prediction.analysis_method;
  const analysisText = analysis
    ? `Calculated: Predicted-expression domains use ${analysis.variable_gene_selection}, ${analysis.standardization}, PCA solver ${analysis.pca_solver}, and K-means with requested k ${analysis.kmeans_requested_k}, fitted k ${analysis.kmeans_fitted_k}, seed ${analysis.kmeans_seed}, and ${analysis.kmeans_n_init} initializations. Returned marker method: ${analysis.marker_effect_size}; ${analysis.marker_test}.`
    : "Annotated: Domain analysis method metadata was not returned.";
  return `Annotated: Model ${metadata.model_version} returned ${metadata.output_type} for a ${metadata.panel_size}-gene panel in ${metadata.mode} mode. Declared reference scope: ${metadata.reference_scope}.\nAnnotated: Retrieval neighbor selection: ${metadata.retrieval_neighbor_selection ?? "not returned"}. Retrieval weighting: ${metadata.retrieval_weighting ?? "not returned"}.\n${supportSummary}\n${analysisText}\nAnnotated: Retrieval diagnostics describe support for predicted values; they are not calibrated confidence or laboratory measurements.`;
}

function answerLimitations(prediction: PredictionResponse): string {
  const warnings = Array.from(new Set([...prediction.warnings, ...prediction.qc.warnings, ...prediction.analysis_warnings]));
  const warningText = warnings.length ? warnings.map((item) => `Annotated: ${item}`).join("\n") : "Annotated: No pipeline, QC, or analysis warnings were returned.";
  return `${warningText}\nAnnotated: Research use only. Values are predicted, not measured. The response does not establish diagnosis, cell type, biomarker status, laboratory equivalence, or calibrated confidence.\nHypothesis: Any biological explanation requires separate evidence and validation; this reader does not generate one.`;
}

export function answer(qRaw: string, prediction: PredictionResponse | null): string {
  if (!prediction) return "Annotated: Load an expanded PredictionResponse before asking this evidence reader about returned QC, genes, domains, retrieval support, methods, or limitations.";
  const question = qRaw.trim().toLowerCase();
  if (!question) return "Annotated: Ask about QC and applicability, a returned gene's highest predicted tile, a domain such as domain_1, retrieval methods, or limitations.";
  if (/\b(qc|quality|applicab|scope|accepted|rejected)\b/.test(question)) return answerQC(prediction);
  if (/\b(limit|warning|caution|research use|measured|diagnos|confidence)\b/.test(question)) return answerLimitations(prediction);
  if (/\b(retrieval|method|model|neighbor|weighting|analysis|pca|k-means|kmeans)\b/.test(question)) return answerMethods(prediction);
  if (/\b(domain|cluster)\b/.test(question)) {
    const domain = domainInQuestion(question, prediction);
    return domain
      ? answerDomain(domain)
      : `Annotated: Name a returned predicted-expression domain: ${prediction.domain_summaries.map((item) => item.domain_id).join(", ") || "none were returned"}.`;
  }
  const gene = geneInQuestion(qRaw, prediction);
  if (gene) return answerGene(gene, prediction);
  return "Annotated: I only route to evidence returned in the loaded response. Ask about QC and applicability, name a panel gene to locate its highest raw prediction tile, name a predicted-expression domain, ask about retrieval methods, or ask for limitations.";
}

export const INTRO_MESSAGE =
  "Evidence-only, rule-based reader. Answers are deterministic and limited to the loaded PredictionResponse; no generative model or external biological annotation is used.";

export const QUICK_QUESTIONS = [
  "Summarize QC and applicability",
  "Where is ERBB2 highest?",
  "Summarize domain_1",
  "Explain retrieval support and methods",
  "State warnings and limitations",
];
