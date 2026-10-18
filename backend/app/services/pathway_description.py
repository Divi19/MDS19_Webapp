"""Descriptions for pathway terms, fetched on demand from the source databases.

Enrichr returns a term's name and statistics only. The text itself lives in
the database the term came from, keyed by the ID in the term name:

  Reactome -> Reactome Content Service, the curators' pathway summary
  GO:BP    -> EBI QuickGO, the ontology's own definition
  KEGG     -> no text fetched (Enrichr's KEGG terms have no ID, and KEGG's
              API is licensed for academic use only); a link-out to KEGG's
              pathway search only.

Both APIs are free and keyless. Results are cached in memory, including
"no description" answers, so a repeat click never hits the network.
"""
import logging
import re
import threading
from urllib.parse import quote_plus

import httpx

from app.services.david_client import PathwayLookupError

logger = logging.getLogger(__name__)

REACTOME_API = "https://reactome.org/ContentService/data/query"
REACTOME_PAGE = "https://reactome.org/content/detail"
QUICKGO_API = "https://www.ebi.ac.uk/QuickGO/services/ontology/go/terms"
QUICKGO_PAGE = "https://www.ebi.ac.uk/QuickGO/term"
KEGG_SEARCH = "https://www.kegg.jp/kegg-bin/search_pathway_text?map=hsa&mode=1&keyword="

_REACTOME_ID = re.compile(r"^R-HSA-\d+$")
_GO_ID = re.compile(r"^GO:\d{7}$")
_TAGS = re.compile(r"<[^>]+>")


def _plain(text: str) -> str:
    return re.sub(r"\s+", " ", _TAGS.sub("", text)).strip()


class PathwayDescriber:
    def __init__(self, timeout: float = 10.0):
        self._http = httpx.Client(timeout=timeout, follow_redirects=True)
        self._lock = threading.Lock()
        self._cache: dict[tuple[str, str], dict] = {}

    def describe(self, category: str, term_id: str, term: str) -> dict:
        """-> {"description": str | None, "url": str}. Raises PathwayLookupError
        when the source database could not be reached (not cached)."""
        key = (category, term_id or term)
        with self._lock:
            cached = self._cache.get(key)
        if cached is not None:
            return cached

        if category == "REACTOME_PATHWAY" and _REACTOME_ID.match(term_id):
            result = self._reactome(term_id)
        elif category == "GOTERM_BP_FAT" and _GO_ID.match(term_id):
            result = self._go(term_id)
        elif category == "KEGG_PATHWAY":
            result = {"description": None, "url": KEGG_SEARCH + quote_plus(term)}
        else:
            raise ValueError("unsupported pathway category or malformed term id")

        with self._lock:
            self._cache[key] = result
        return result

    def _get_json(self, url: str):
        try:
            resp = self._http.get(url, headers={"Accept": "application/json"})
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
            return resp.json()
        except Exception as exc:
            logger.warning("Pathway description request failed: %r", exc)
            raise PathwayLookupError(f"Description lookup failed: {exc}") from exc

    def _reactome(self, term_id: str) -> dict:
        data = self._get_json(f"{REACTOME_API}/{term_id}")
        text = ""
        if isinstance(data, dict):
            text = " ".join(_plain(s.get("text", "")) for s in data.get("summation") or [])
        return {"description": text or None, "url": f"{REACTOME_PAGE}/{term_id}"}

    def _go(self, term_id: str) -> dict:
        data = self._get_json(f"{QUICKGO_API}/{term_id}")
        text = ""
        results = data.get("results") if isinstance(data, dict) else None
        if results:
            text = _plain((results[0].get("definition") or {}).get("text", ""))
        return {"description": text or None, "url": f"{QUICKGO_PAGE}/{term_id}"}
