"""
Pathway enrichment via DAVID (davidbioinformatics.nih.gov), querying KEGG,
Reactome, and GO Biological Process by default — "where is this gene
commonly found." KEGG alone was the original default, but a 5-gene cluster
marker set often has nothing in KEGG specifically even when it has a real,
well-annotated signal elsewhere (confirmed live: the same 5-gene HER2+ set
went from 1 KEGG hit to 18 hits across all three categories, all passing
DAVID's own significance filter) — DAVID is a hub over many annotation
databases, not just KEGG, so querying more of them is a wider question to
the same service, not a new integration.

Two things about DAVID's web service are easy to get wrong silently, both
confirmed by hand against the live service before writing this:

1. addList does NOT accept gene symbols, despite the web UI offering
   OFFICIAL_GENE_SYMBOL as an option — symbols are ambiguous across
   species, so the SOAP service only accepts accession-style IDs
   (ENTREZ_GENE_ID, ENSEMBL_GENE_ID, etc). Symbols must be converted to
   Entrez IDs first (via MyGene.info, same free no-key service the
   frontend already uses for gene descriptions) or addList silently
   returns a mapped-fraction of -1 and getChartReport then errors.
2. DAVID-WS is a *stateful* session: addList sets a server-side "current
   list" that setCategories/getChartReport then act on implicitly. There
   is no per-request isolation — if two requests interleaved their calls
   under the same registered email, one could read the other's list. A
   process-wide lock serialises every full addList->setCategories->
   getChartReport sequence so that can't happen. Given this app's actual
   traffic (occasional user-triggered lookups, not a hot path), losing
   concurrency here costs nothing noticeable and removes a real race
   condition DAVID's own architecture doesn't protect against.
"""
import logging
import threading
import uuid

import httpx
from zeep import Client
from zeep.transports import Transport

logger = logging.getLogger(__name__)

DAVID_WSDL = "https://davidbioinformatics.nih.gov/webservice/services/DAVIDWebService?wsdl"
MYGENE_URL = "https://mygene.info/v3/query"

# DAVID's own defaults (EASE threshold 0.1, min 2 genes per term) are tuned
# for list sizes much larger than a 5-gene cluster marker set — at count=2,
# small lists return nothing even when individual genes have real pathway
# hits. count=1 surfaces those; threshold stays at DAVID's own default.
DEFAULT_EASE = 0.1
DEFAULT_MIN_COUNT = 1

# setCategories() takes a comma-separated list — DAVID treats it as "any of
# these", not "all of these", so this just widens which of its own
# annotation databases get searched. KEGG alone frequently returns nothing
# for a 5-gene cluster marker set; REACTOME_PATHWAY and GOTERM_BP_FAT (GO
# Biological Process) cover a lot of real biology KEGG doesn't curate.
DEFAULT_CATEGORIES = "KEGG_PATHWAY,REACTOME_PATHWAY,GOTERM_BP_FAT"


class PathwayLookupError(Exception):
    """Raised for any DAVID/MyGene failure the route should surface as an
    error rather than an empty result (auth failure, network error, etc).
    An empty gene list or zero enriched terms is NOT an error — those
    return normally as an empty list."""


class DavidClient:
    def __init__(self, email: str):
        if not email:
            raise ValueError("DAVID_EMAIL is required to use DavidClient")
        self.email = email
        self._lock = threading.Lock()
        # The WSDL itself is a static schema document, not session state —
        # safe to parse once and reuse. Only the actual addList/setCategories/
        # getChartReport call sequence (below) needs the lock.
        self._client = Client(DAVID_WSDL, transport=Transport(timeout=30, operation_timeout=30))

    def _symbols_to_entrez(self, symbols: list[str]) -> dict[str, str]:
        """gene symbol -> Entrez Gene ID, for whichever of `symbols` MyGene
        actually resolves. Silently drops unresolved symbols — a gene with
        no Entrez mapping simply can't be sent to DAVID, not a hard error."""
        if not symbols:
            return {}
        try:
            resp = httpx.post(
                MYGENE_URL,
                data={
                    "q": ",".join(symbols),
                    "scopes": "symbol",
                    "species": "human",
                    "fields": "symbol,entrezgene",
                },
                timeout=15.0,
            )
            resp.raise_for_status()
            hits = resp.json()
        except Exception as exc:
            raise PathwayLookupError(f"Gene ID lookup failed: {exc}") from exc

        mapping: dict[str, str] = {}
        for hit in hits:
            entrez = hit.get("entrezgene")
            symbol = hit.get("symbol")
            if entrez and symbol and not hit.get("notfound"):
                mapping[symbol] = str(entrez)
        return mapping

    def get_pathways(
        self,
        gene_symbols: list[str],
        category: str = DEFAULT_CATEGORIES,
        ease: float = DEFAULT_EASE,
        min_count: int = DEFAULT_MIN_COUNT,
    ) -> list[dict]:
        symbol_by_entrez = {v: k for k, v in self._symbols_to_entrez(gene_symbols).items()}
        if not symbol_by_entrez:
            logger.info("No gene symbols resolved to Entrez IDs for %r", gene_symbols)
            return []

        entrez_csv = ",".join(symbol_by_entrez.keys())
        list_name = f"genex_{uuid.uuid4().hex[:8]}"

        with self._lock:
            try:
                if not self._client.service.authenticate(self.email):
                    raise PathwayLookupError(
                        f"DAVID did not recognise the registered email {self.email!r}")

                mapped_fraction = self._client.service.addList(
                    entrez_csv, "ENTREZ_GENE_ID", list_name, 0)
                if mapped_fraction is None or mapped_fraction < 0:
                    raise PathwayLookupError(
                        "DAVID rejected the gene list (addList returned an error)")

                self._client.service.setCategories(category)
                records = self._client.service.getChartReport(ease, min_count)
            except PathwayLookupError:
                raise
            except Exception as exc:
                raise PathwayLookupError(f"DAVID request failed: {exc}") from exc

        results = []
        for rec in records or []:
            # DAVID returns this comma-SPACE separated ("919, 7535, 915"),
            # not bare comma-separated — an unstripped split leaves every ID
            # but the first with a leading space, which then silently fails
            # the dict lookup below and drops every gene but one per term.
            hit_entrez = [e.strip() for e in (rec.geneIds or "").split(",")] if rec.geneIds else []
            hit_symbols = [symbol_by_entrez[e] for e in hit_entrez if e in symbol_by_entrez]
            results.append({
                "term": rec.termName,
                "category": rec.categoryName,
                "pvalue": rec.ease,
                "benjamini": rec.benjamini,
                "fold_enrichment": rec.foldEnrichment,
                "list_hits": rec.listHits,
                "list_total": rec.listTotals,
                "genes": hit_symbols,
            })
        results.sort(key=lambda r: r["pvalue"])
        return results
