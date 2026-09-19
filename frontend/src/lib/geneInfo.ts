/**
 * Real gene name + description, via MyGene.info — a free, no-key REST API
 * (CORS-enabled, safe to call directly from the browser) that aggregates
 * NCBI/Ensembl/UniProt annotations. This is deliberately not GeneCards:
 * GeneCards' API sits behind an academic-collaboration approval process,
 * not a self-serve key, so it isn't viable on this project's timeline.
 */

export interface GeneInfo {
  symbol: string;
  name: string;
  summary: string | null;
}

const cache = new Map<string, GeneInfo | null>();
const inflight = new Map<string, Promise<GeneInfo | null>>();

export async function fetchGeneInfo(symbol: string): Promise<GeneInfo | null> {
  if (cache.has(symbol)) return cache.get(symbol) ?? null;
  const existing = inflight.get(symbol);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const url = `https://mygene.info/v3/query?q=symbol:${encodeURIComponent(symbol)}&species=human&fields=name,summary,symbol&size=1`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`MyGene.info returned ${res.status}`);
      const data = await res.json();
      const hit = data.hits?.[0];
      const info: GeneInfo | null = hit
        ? {
            symbol: hit.symbol ?? symbol,
            name: hit.name ?? symbol,
            summary: hit.summary ?? null,
          }
        : null;
      cache.set(symbol, info);
      return info;
    } catch {
      // Network failure or no match — cached as null so a flaky request
      // doesn't get retried every single click on the same gene.
      cache.set(symbol, null);
      return null;
    } finally {
      inflight.delete(symbol);
    }
  })();

  inflight.set(symbol, promise);
  return promise;
}
