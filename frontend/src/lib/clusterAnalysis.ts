import type { Prediction } from "@/lib/mockPrediction";

export interface ClusterMarker {
  name: string;
  diff: number;
}

/** Below this many spots, a mean-difference estimate is easily dominated by
 * one or two outliers — flag it rather than presenting it with the same
 * confidence as a well-populated cluster. */
const LOW_SAMPLE_THRESHOLD = 10;

export interface ClusterAnalysis {
  index: number;
  count: number;
  fraction: number;
  /** Top genes by (mean expression in this cluster) minus (mean expression
   * everywhere else) — a differential signal, not a cell-type identity. */
  markers: ClusterMarker[];
  summary: string;
  lowSample: boolean;
}

/** Every spot already carries its cluster id and its normalised expression
 * for the full gene panel (see toPrediction in api.ts) — this only groups
 * data already in memory, no extra fetch or backend call. */
export function analyzeClusters(pred: Prediction, topN = 5): ClusterAnalysis[] {
  const k = pred.clusters.length || 5;
  const genes = pred.genes;
  const totalCount = pred.spots.length;

  const sumsByCluster: Map<string, number>[] = Array.from({ length: k }, () => new Map());
  const totalSums = new Map<string, number>();
  const counts = new Array(k).fill(0);

  for (const spot of pred.spots) {
    counts[spot.cluster] = (counts[spot.cluster] ?? 0) + 1;
    const clusterSums = sumsByCluster[spot.cluster];
    for (const gene of genes) {
      const value = spot.expr[gene] ?? 0;
      clusterSums.set(gene, (clusterSums.get(gene) ?? 0) + value);
      totalSums.set(gene, (totalSums.get(gene) ?? 0) + value);
    }
  }

  return Array.from({ length: k }, (_, c) => {
    const nIn = counts[c] ?? 0;
    const nOut = totalCount - nIn;
    const markers: ClusterMarker[] = [];

    if (nIn > 0 && nOut > 0) {
      for (const gene of genes) {
        const sumIn = sumsByCluster[c].get(gene) ?? 0;
        const sumOut = (totalSums.get(gene) ?? 0) - sumIn;
        markers.push({ name: gene, diff: sumIn / nIn - sumOut / nOut });
      }
      markers.sort((a, b) => b.diff - a.diff);
    }

    const top = markers.slice(0, topN);
    const fraction = pred.total ? nIn / pred.total : 0;
    const first = top[0];
    const lowSample = nIn > 0 && nIn < LOW_SAMPLE_THRESHOLD;
    const summary =
      nIn === 0
        ? "No spots assigned to this cluster."
        : `${nIn} spot${nIn === 1 ? "" : "s"} (${(fraction * 100).toFixed(1)}% of tissue).` +
          (first
            ? ` Top gene ${first.name} is ${first.diff >= 0 ? "elevated" : "reduced"} by ${Math.abs(first.diff).toFixed(2)} vs. the rest of the tissue.`
            : "") +
          (lowSample ? " Small sample — interpret with caution." : "");

    return { index: c, count: nIn, fraction, markers: top, summary, lowSample };
  });
}
