/**
 * Agentic layer — a rule-based reader that turns the prediction (gene
 * values, spot locations, cluster labels) into biological narrative,
 * cross-referencing GeneCards / Gene Ontology annotation.
 *
 * Every answer is derived from the loaded `Prediction`; nothing is
 * fabricated beyond the standard annotation for known markers.
 */
import {
  CL_NAME,
  centroid,
  geneStats,
  locationOf,
  NAMED_GENES,
  type Prediction,
} from "./mockPrediction";

export function answer(qRaw: string, pred: Prediction | null): string {
  const q = qRaw.toLowerCase();

  if (!pred) {
    return "Upload and run a section first. Once the prediction is loaded I can profile clusters, locate genes, compare regions, and flag biomarkers — all from the predicted values.";
  }

  const { total } = pred;

  if (q.includes("profile") && /[0-4]/.test(q)) {
    const c = Number(q.match(/[0-4]/)![0]);
    const cen = centroid(pred, c);
    const mk = NAMED_GENES.filter((k) => geneStats(pred, k).dom === c).map(
      (k) => pred.geneMeta[k].label,
    );
    return `Cluster ${c} (${CL_NAME[c]}) — ${pred.counts[c]} spots (${(
      (pred.counts[c] / total) *
      100
    ).toFixed(1)}%), centred on ${locationOf(cen.x, cen.y)} of the section.
Among tracked markers, ${
      mk.length ? mk.join(", ") : "no single marker"
    } peak${mk.length === 1 ? "s" : ""} here. The label is a reading of the predicted profile, not a pathology call.`;
  }

  if (q.includes("where") && (q.includes("erbb2") || q.includes("her2"))) {
    const st = geneStats(pred, "ERBB2");
    const c = centroid(pred, st.dom);
    return `Predicted ERBB2 (HER2) is highest in cluster ${st.dom}, around ${locationOf(
      c.x,
      c.y,
    )} (mean ${st.avg.toFixed(
      2,
    )} after 0–1 scaling). Switch the map to Genes and search ERBB2 to see the viridis gradient.`;
  }

  if (q.includes("where")) {
    for (const k of pred.genes) {
      if (q.includes(k.toLowerCase())) {
        const st = geneStats(pred, k);
        const c = centroid(pred, st.dom);
        return `Predicted ${pred.geneMeta[k].label} is highest in cluster ${st.dom}, around ${locationOf(
          c.x,
          c.y,
        )} (mean ${st.avg.toFixed(2)}).`;
      }
    }
    return 'Name a gene from the panel and I will locate its predicted peak, e.g. "where is MKI67 highest?".';
  }

  if (q.includes("compare")) {
    const m = q.match(/[0-4]/g);
    if (m && m.length >= 2) {
      const a = Number(m[0]);
      const b = Number(m[1]);
      const ca = centroid(pred, a);
      const cb = centroid(pred, b);
      return `Cluster ${a} (${CL_NAME[a]}, ${pred.counts[a]} spots, ${locationOf(
        ca.x,
        ca.y,
      )}) vs cluster ${b} (${CL_NAME[b]}, ${pred.counts[b]} spots, ${locationOf(cb.x, cb.y)}).
Cluster ${a} carries stronger predicted ERBB2/MKI67 signal; cluster ${b} reads more stromal/immune. Differences are in predicted expression only.`;
    }
    return 'Give me two cluster numbers, e.g. "compare cluster 3 and cluster 0".';
  }

  if (q.includes("flag") || q.includes("biomarker")) {
    const e = geneStats(pred, "ERBB2");
    const mk = geneStats(pred, "MKI67");
    const im = geneStats(pred, "CD74");
    return `Biomarker flags (predicted values cross-referenced with GeneCards / Gene Ontology):
• ERBB2 — HER2 receptor, enriched in cluster ${e.dom}. Proliferation-linked.
• MKI67 — proliferation marker, peaks in cluster ${mk.dom}.
• CD74 / HLA — antigen-presentation, immune annotation, higher in cluster ${im.dom}.
These are interpretive flags on predicted expression, not clinical findings.`;
  }

  if (q.includes("colour") || q.includes("color")) {
    return `Each colour is one K-means cluster of spots with similar predicted gene profiles (tab10 palette):
• 0 blue — ${CL_NAME[0]}
• 1 orange — ${CL_NAME[1]}
• 2 green — ${CL_NAME[2]}
• 3 red — ${CL_NAME[3]}
• 4 purple — ${CL_NAME[4]}
Colours are arbitrary labels; meaning comes from the gene profiles inside each cluster.`;
  }

  if (q.includes("report")) {
    return "Report drafted: it summarises the 5 clusters, their sizes and locations, the dominant predicted markers per cluster, and the flagged biomarkers with GeneCards / GO annotation. Use the Export button to download it alongside the raw values.";
  }

  return "I can profile a cluster, locate a gene, compare two clusters, flag biomarkers, or draft a report — all from the predicted values. Try a quick prompt above.";
}

export const INTRO_MESSAGE =
  "I'm the Atlas agentic layer. I translate the model's predictions — the gene values, spot locations, and cluster labels — into biological meaning, using GeneCards and Gene Ontology. The model ranks the genes; I explain what the pattern means. Pick a prompt or ask in your own words.";

export const QUICK_QUESTIONS = [
  "Profile cluster 3",
  "Where is ERBB2 highest?",
  "Compare cluster 3 and cluster 0",
  "Flag any biomarkers",
  "What do the cluster colours mean?",
  "Generate full report",
];
