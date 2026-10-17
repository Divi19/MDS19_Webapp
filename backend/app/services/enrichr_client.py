"""
Pathway enrichment via Enrichr (maayanlab.cloud/Enrichr), the drop-in
replacement for david_client.DavidClient.

DAVID's SOAP service stopped answering from the production host (every
authenticate() call read-timed-out at 30s), so lookups could never succeed.
Enrichr is a plain HTTP API: no registration, no stateful session (so no
process-wide lock), and it takes gene SYMBOLS directly (so no MyGene
symbol->Entrez step).

Two calls per library: POST addList (a newline-separated symbol list ->
userListId), then GET enrich?userListId=..&backgroundType=<library>. The
libraries are queried in parallel.

Same public surface as DavidClient — get_pathways(gene_symbols, category=...)
returns dicts shaped like routes' PathwayResult — so the route, the frontend
and the PDF report need no change. Enrichr does not report fold enrichment
or a list total per term, so fold_enrichment is 0.0 and nothing reads it.
"""
import logging
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import httpx

from app.services.david_client import (
    CACHE_MAX_ENTRIES,
    DEFAULT_CATEGORIES,
    PathwayLookupError,
)

logger = logging.getLogger(__name__)

ENRICHR_URL = "https://maayanlab.cloud/Enrichr"

# DAVID category name (what the API's `category` field and DEFAULT_CATEGORIES
# use) -> Enrichr library. A name not listed here is passed through as an
# Enrichr library name, so callers can also ask for one directly.
LIBRARY_BY_CATEGORY = {
    "KEGG_PATHWAY": "KEGG_2021_Human",
    "REACTOME_PATHWAY": "Reactome_2022",
    "GOTERM_BP_FAT": "GO_Biological_Process_2023",
}
# What the UI shows as a term's category: the DAVID-style short names the
# rest of the app already expects.
CATEGORY_BY_LIBRARY = {v: k for k, v in LIBRARY_BY_CATEGORY.items()}

# DAVID's own cut-off was EASE <= 0.1; for a 5-gene marker set a raw
# p <= 0.05 is the more defensible "significant" bar, and Enrichr's adjusted
# p-values are too strict to ever pass at that list size.
MAX_PVALUE = 0.05
MAX_TERMS_PER_LIBRARY = 10

_TERM_SUFFIXES = (
    re.compile(r"\s*\(GO:\d+\)\s*$"),      # "cell cycle (GO:0007049)"
    re.compile(r"\s+R-HSA-\d+(\.\d+)?\s*$"),  # "Cell Cycle R-HSA-1640170"
)


def _clean_term(term: str) -> str:
    for pattern in _TERM_SUFFIXES:
        term = pattern.sub("", term)
    return term.strip()


class EnrichrClient:
    def __init__(self, timeout: float = 20.0):
        self._http = httpx.Client(timeout=timeout, follow_redirects=True)
        self._cache_lock = threading.Lock()
        self._result_cache: dict[tuple, list[dict]] = {}

    def _add_list(self, symbols: list[str]) -> int:
        resp = self._http.post(
            f"{ENRICHR_URL}/addList",
            files={"list": (None, "\n".join(symbols)),
                   "description": (None, "genex")},
        )
        resp.raise_for_status()
        user_list_id = resp.json().get("userListId")
        if user_list_id is None:
            raise PathwayLookupError("Enrichr did not accept the gene list")
        return user_list_id

    def _enrich(self, user_list_id: int, library: str) -> list[list]:
        resp = self._http.get(
            f"{ENRICHR_URL}/enrich",
            params={"userListId": user_list_id, "backgroundType": library},
        )
        resp.raise_for_status()
        return resp.json().get(library, [])

    def get_pathways(self, gene_symbols: list[str], category: str = DEFAULT_CATEGORIES,
                     **_ignored) -> list[dict]:
        symbols = sorted({s.strip() for s in gene_symbols if s and s.strip()})
        if not symbols:
            return []
        categories = [c.strip() for c in category.split(",") if c.strip()]
        cache_key = (tuple(symbols), tuple(categories))
        with self._cache_lock:
            cached = self._result_cache.get(cache_key)
        if cached is not None:
            logger.info("Enrichr cache hit for %d genes", len(symbols))
            return cached

        started = time.monotonic()
        libraries = [LIBRARY_BY_CATEGORY.get(c, c) for c in categories]
        try:
            user_list_id = self._add_list(symbols)
            with ThreadPoolExecutor(max_workers=max(1, len(libraries))) as pool:
                per_library = list(pool.map(
                    lambda lib: self._enrich(user_list_id, lib), libraries))
        except PathwayLookupError:
            raise
        except Exception as exc:
            logger.warning("Enrichr request failed: %r", exc)
            raise PathwayLookupError(f"Enrichr request failed: {exc}") from exc

        results = []
        for library, rows in zip(libraries, per_library):
            for row in rows[:MAX_TERMS_PER_LIBRARY]:
                # [rank, term, p, z-score, combined score, [genes], adj p, ...]
                _rank, term, pvalue, _z, _combined, genes, adj_p = row[:7]
                if pvalue > MAX_PVALUE:
                    continue
                results.append({
                    "term": _clean_term(term),
                    "category": CATEGORY_BY_LIBRARY.get(library, library),
                    "pvalue": pvalue,
                    "benjamini": adj_p,
                    "fold_enrichment": 0.0,
                    "list_hits": len(genes),
                    "list_total": len(symbols),
                    "genes": list(genes),
                })
        results.sort(key=lambda r: r["pvalue"])

        logger.info("Enrichr lookup of %d genes took %.1fs (%d terms)",
                    len(symbols), time.monotonic() - started, len(results))
        with self._cache_lock:
            if len(self._result_cache) >= CACHE_MAX_ENTRIES:
                self._result_cache.pop(next(iter(self._result_cache)))
            self._result_cache[cache_key] = results
        return results
