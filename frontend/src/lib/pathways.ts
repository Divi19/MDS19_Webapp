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

/** Per-cluster pathway lookup state, keyed by cluster index. Lives in
 * GeneXApp (lifted from ClusterAnalysisPanel) so the PDF export can read
 * already-fetched results instead of re-querying DAVID. */
export type PathwayState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "done"; results: PathwayResult[] };

/** Pathway enrichment (DAVID) for a small gene list — a cluster's marker
 * genes, or a single gene. Queries KEGG, Reactome, and GO Biological
 * Process by default (the backend's DEFAULT_CATEGORIES, the single source
 * of truth — omitted here so `category` left unset means exactly that, not
 * a second copy of the list). Throws with a message safe to show directly
 * (the backend's own error text), including the clean "not configured"
 * case (DAVID_EMAIL unset) as a 501. */
export async function fetchPathways(
  genes: string[],
  category?: string,
): Promise<PathwayResult[]> {
  const res = await fetch(`${API_URL}/api/pathways`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ genes, category }),
    // Just above the backend's own 45s ceiling, so its readable 504 wins
    // over a bare client-side abort.
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Pathway lookup failed (${res.status}): ${detail}`);
  }
  return res.json();
}
