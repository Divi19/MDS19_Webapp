from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import httpx


GPROFILER_API_VERSION = "e111_eg58_p18"
GPROFILER_URL = f"https://biit.cs.ut.ee/gprofiler_archive3/{GPROFILER_API_VERSION}/api/gost/profile/"
ALLOWED_SOURCES = {"GO:BP", "GO:CC", "GO:MF", "REAC", "KEGG", "WP"}
STRICT_TIMEOUT = httpx.Timeout(5.0, connect=2.0, read=5.0, write=5.0, pool=2.0)


class PathwayInputError(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


class PathwayUpstreamError(RuntimeError):
    def __init__(self, code: str, status_code: int):
        self.code = code
        self.status_code = status_code
        super().__init__(code)


def enrich_pathways(
    genes: list[str],
    background: list[str],
    sources: list[str] | None = None,
    client: httpx.Client | None = None,
) -> dict[str, Any]:
    query = sorted({str(gene).strip() for gene in genes if str(gene).strip()})
    panel = sorted({str(gene).strip() for gene in background if str(gene).strip()})
    selected_sources = sorted(set(sources or ["GO:BP", "GO:CC", "GO:MF", "REAC"]))
    if not query:
        raise PathwayInputError("PATHWAY_EMPTY_QUERY")
    if len(panel) != 785:
        raise PathwayInputError("PATHWAY_BACKGROUND_UNAVAILABLE")
    if any(gene not in panel for gene in query):
        raise PathwayInputError("PATHWAY_GENES_OUTSIDE_PANEL")
    if not selected_sources or any(source not in ALLOWED_SOURCES for source in selected_sources):
        raise PathwayInputError("PATHWAY_INVALID_SOURCE")
    payload = {
        "organism": "hsapiens",
        "query": query,
        "sources": selected_sources,
        "user_threshold": 0.05,
        "significance_threshold_method": "g_SCS",
        "domain_scope": "custom",
        "background": panel,
        "no_evidences": False,
    }
    owns_client = client is None
    active_client = client or httpx.Client(timeout=STRICT_TIMEOUT)
    try:
        response = active_client.post(GPROFILER_URL, json=payload, timeout=STRICT_TIMEOUT)
    except (httpx.TimeoutException, httpx.NetworkError) as exc:
        raise PathwayUpstreamError("PATHWAY_SERVICE_UNAVAILABLE", 503) from exc
    finally:
        if owns_client:
            active_client.close()
    if response.status_code >= 500:
        raise PathwayUpstreamError("PATHWAY_UPSTREAM_UNAVAILABLE", 503)
    if response.status_code >= 400:
        raise PathwayUpstreamError("PATHWAY_UPSTREAM_REJECTED_REQUEST", 502)
    try:
        data = response.json()
        raw_terms = data["result"]
        if not isinstance(raw_terms, list):
            raise TypeError
    except (ValueError, KeyError, TypeError) as exc:
        raise PathwayUpstreamError("PATHWAY_INVALID_UPSTREAM_RESPONSE", 502) from exc
    terms = []
    for term in raw_terms:
        try:
            source = str(term["source"])
            term_id = str(term["native"] if "native" in term else term["term_id"])
            name = str(term["name"])
            adjusted_p_value = float(term["p_value"])
            contributing = sorted({str(gene) for gene in term.get("intersection", []) if str(gene) in query})
        except (KeyError, TypeError, ValueError) as exc:
            raise PathwayUpstreamError("PATHWAY_INVALID_UPSTREAM_RESPONSE", 502) from exc
        terms.append({
            "source": source,
            "term_id": term_id,
            "term_name": name,
            "adjusted_p_value": adjusted_p_value,
            "contributing_genes": contributing,
        })
    terms.sort(key=lambda term: (term["adjusted_p_value"], term["source"], term["term_id"]))
    warnings = []
    if not terms:
        warnings.append("No terms passed the requested g:Profiler adjusted significance threshold")
    return {
        "api_version": GPROFILER_API_VERSION,
        "query": query,
        "background": panel,
        "timestamp": datetime.now(timezone.utc),
        "terms": terms,
        "warnings": warnings,
    }
