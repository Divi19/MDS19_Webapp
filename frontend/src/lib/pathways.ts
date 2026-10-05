const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export interface PathwayResult {
  term: string;
  category: string;
  pvalue: number;
  benjamini: number;
  fold_enrichment: number;
  list_hits: number;
  list_total: number;
  genes: string[];
}

/** Pathway enrichment (DAVID, KEGG_PATHWAY by default) for a small gene
 * list — a cluster's marker genes, or a single gene. Throws with a message
 * safe to show directly (the backend's own error text), including the
 * clean "not configured" case (DAVID_EMAIL unset) as a 501. */
export async function fetchPathways(
  genes: string[],
  category = "KEGG_PATHWAY",
): Promise<PathwayResult[]> {
  const res = await fetch(`${API_URL}/api/pathways`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ genes, category }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Pathway lookup failed (${res.status}): ${detail}`);
  }
  return res.json();
}
