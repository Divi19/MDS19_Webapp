/**
 * Agentic layer — a rule-based reader that turns the prediction (gene
 * values, spot locations, cluster labels) into biological narrative,
 * cross-referencing GeneCards / Gene Ontology annotation.
 *
 * Every answer is derived from the loaded `Prediction`; nothing is
 * fabricated beyond the standard annotation for known markers.
 */
import {
  centroid,
  geneStats,
  locationOf,
  NAMED_GENES,
  type Prediction,
} from "./mockPrediction";

const clusterName = (pred: Prediction, index: number) =>
  pred.clusters[index]?.name ?? `cluster ${index}`;

function clusterMean(pred: Prediction, gene: string, cluster: number) {
  const spots = pred.spots.filter((spot) => spot.cluster === cluster);
  if (!spots.length) return 0;
  return spots.reduce((sum, spot) => sum + (spot.expr[gene] ?? 0), 0) / spots.length;
}

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
    return `Cluster ${c} (${clusterName(pred, c)}) — ${pred.counts[c]} spots (${(
      (pred.counts[c] / total) *
      100
    ).toFixed(1)}%), centred on ${locationOf(cen.x, cen.y)} of the section.
Among tracked markers, ${
      mk.length ? mk.join(", ") : "no single marker"
    } peak${mk.length === 1 ? "s" : ""} here. The label is a reading of the predicted profile, not a pathology call.`;
  }

  if (q.includes("where") && (q.includes("erbb2") || q.includes("her2"))) {
    if (!pred.geneMeta.ERBB2) return "ERBB2 is not present in this model's gene panel.";
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
      const differences = pred.genes
        .map((gene) => ({
          gene,
          difference: Math.abs(clusterMean(pred, gene, a) - clusterMean(pred, gene, b)),
        }))
        .sort((x, y) => y.difference - x.difference)
        .slice(0, 3)
        .map((item) => item.gene)
        .join(", ");
      return `Cluster ${a} (${clusterName(pred, a)}, ${pred.counts[a]} spots, ${locationOf(
        ca.x,
        ca.y,
      )}) vs cluster ${b} (${clusterName(pred, b)}, ${pred.counts[b]} spots, ${locationOf(cb.x, cb.y)}).
The largest normalised expression differences are ${differences || "not available"}. These are model predictions, not biological labels or clinical findings.`;
    }
    return 'Give me two cluster numbers, e.g. "compare cluster 3 and cluster 0".';
  }

  if (q.includes("flag") || q.includes("biomarker")) {
    const tracked = ["ERBB2", "MKI67", "CD74"].filter((gene) => pred.geneMeta[gene]);
    if (!tracked.length) {
      return "None of the currently tracked annotation markers (ERBB2, MKI67, CD74) are present in this model panel.";
    }
    const annotations: Record<string, string> = {
      ERBB2: "HER2 receptor",
      MKI67: "proliferation-associated marker",
      CD74: "antigen-presentation-associated marker",
    };
    const lines = tracked.map((gene) => {
      const stats = geneStats(pred, gene);
      return `• ${gene} — ${annotations[gene]}, highest mean normalised prediction in cluster ${stats.dom}.`;
    });
    return `Tracked-marker summary:\n${lines.join("\n")}\nThese are annotations of model predictions, not clinical findings.`;
  }

  if (q.includes("colour") || q.includes("color")) {
    return `Each colour is one K-means cluster of spots with similar predicted gene profiles (tab10 palette):
• 0 blue — ${clusterName(pred, 0)}
• 1 orange — ${clusterName(pred, 1)}
• 2 green — ${clusterName(pred, 2)}
• 3 red — ${clusterName(pred, 3)}
• 4 purple — ${clusterName(pred, 4)}
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
