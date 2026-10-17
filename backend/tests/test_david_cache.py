"""DavidClient caching: repeat lookups must not hit DAVID/MyGene again, and
failures must never be cached."""
import threading
from types import SimpleNamespace

import pytest

from app.services import david_client
from app.services.david_client import DavidClient, PathwayLookupError


def _client():
    c = DavidClient.__new__(DavidClient)  # skip the WSDL download in __init__
    c.email = "x@example.org"
    c._lock = threading.Lock()
    c._cache_lock = threading.Lock()
    c._result_cache = {}
    c._entrez_cache = {}
    c.calls = {"mygene": 0, "david": 0}

    def authenticate(_email):
        c.calls["david"] += 1
        return True

    rec = SimpleNamespace(termName="t", categoryName="KEGG", ease=0.01, benjamini=0.02,
                          foldEnrichment=3.0, listHits=1, listTotals=2, geneIds="1")
    c._client = SimpleNamespace(service=SimpleNamespace(
        authenticate=authenticate,
        addList=lambda *a: 1.0,
        setCategories=lambda *a: None,
        getChartReport=lambda *a: [rec],
    ))
    return c


@pytest.fixture
def mygene(monkeypatch):
    calls = []

    def fake_post(url, data, timeout):
        calls.append(data["q"])
        return SimpleNamespace(
            raise_for_status=lambda: None,
            json=lambda: [{"query": "A", "symbol": "A", "entrezgene": "1"}])

    monkeypatch.setattr(david_client.httpx, "post", fake_post)
    return calls


def test_repeat_lookup_is_cached_and_order_insensitive(mygene):
    c = _client()
    first = c.get_pathways(["A"])
    second = c.get_pathways(["A"])
    assert first == second and first[0]["genes"] == ["A"]
    assert c.calls["david"] == 1
    assert len(mygene) == 1


def test_entrez_mapping_reused_across_categories(mygene):
    c = _client()
    c.get_pathways(["A"], category="KEGG_PATHWAY")
    c.get_pathways(["A"], category="GOTERM_BP_FAT")  # new result key, same symbols
    assert c.calls["david"] == 2
    assert len(mygene) == 1


def test_failures_are_not_cached(mygene):
    c = _client()
    c._client.service.authenticate = lambda _e: False
    with pytest.raises(PathwayLookupError):
        c.get_pathways(["A"])
    assert c._result_cache == {}
    c._client.service.authenticate = lambda _e: True
    assert c.get_pathways(["A"])
