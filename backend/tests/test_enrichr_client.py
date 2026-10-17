"""EnrichrClient: request shape, result mapping/filtering, caching, errors."""
import httpx
import pytest

from app.services import enrichr_client

from app.services.david_client import PathwayLookupError
from app.services.enrichr_client import EnrichrClient

ROWS = {
    "KEGG_2021_Human": [
        [1, "Cell cycle", 0.001, 5.0, 40.0, ["CDK1", "CCNB1"], 0.02, 0, 0],
        [2, "Too weak", 0.4, 1.0, 1.0, ["CDK1"], 0.9, 0, 0],
    ],
    "Reactome_2022": [
        [1, "Mitotic Prometaphase R-HSA-68877", 0.004, 4.0, 20.0, ["CDK1"], 0.03, 0, 0],
    ],
    "GO_Biological_Process_2023": [
        [1, "mitotic cell cycle (GO:0000278)", 0.0005, 6.0, 60.0, ["CDK1", "CCNB1"], 0.01, 0, 0],
    ],
}


def _client(calls, fail_enrich=False):
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.path.endswith("/addList"):
            assert b"CCNB1\nCDK1" in request.content  # sorted, newline separated
            return httpx.Response(200, json={"userListId": 7, "shortId": "x"})
        if fail_enrich:
            return httpx.Response(500, text="boom")
        lib = request.url.params["backgroundType"]
        assert request.url.params["userListId"] == "7"
        return httpx.Response(200, json={lib: ROWS[lib]})

    c = EnrichrClient()
    c._http = httpx.Client(transport=httpx.MockTransport(handler))
    return c


def test_maps_filters_and_sorts():
    calls = []
    out = _client(calls).get_pathways(["CDK1", "CCNB1"])
    assert [r["term"] for r in out] == [
        "mitotic cell cycle", "Cell cycle", "Mitotic Prometaphase"]  # p-sorted, ids stripped
    assert {r["category"] for r in out} == {"KEGG_PATHWAY", "REACTOME_PATHWAY", "GOTERM_BP_FAT"}
    top = out[0]
    assert top["genes"] == ["CDK1", "CCNB1"] and top["list_hits"] == 2 and top["list_total"] == 2
    assert top["benjamini"] == 0.01 and top["fold_enrichment"] == 0.0
    assert len(calls) == 1 + 3  # one addList + one enrich per library


def test_repeat_lookup_is_cached():
    calls = []
    c = _client(calls)
    c.get_pathways(["CDK1", "CCNB1"])
    c.get_pathways(["CCNB1", "CDK1"])
    assert len(calls) == 4


def test_empty_genes_makes_no_requests():
    calls = []
    assert _client(calls).get_pathways([" ", ""]) == []
    assert calls == []


def test_http_failure_raises_and_is_not_cached():
    calls = []
    c = _client(calls, fail_enrich=True)
    with pytest.raises(PathwayLookupError):
        c.get_pathways(["CDK1", "CCNB1"])
    assert c._result_cache == {}


def test_429_is_retried_then_succeeds(monkeypatch):
    monkeypatch.setattr(enrichr_client.time, "sleep", lambda _s: None)
    attempts = {"addList": 0}

    def handler(request):
        if request.url.path.endswith("/addList"):
            attempts["addList"] += 1
            if attempts["addList"] < 3:
                return httpx.Response(429, headers={"Retry-After": "1"})
            return httpx.Response(200, json={"userListId": 7})
        lib = request.url.params["backgroundType"]
        return httpx.Response(200, json={lib: ROWS[lib]})

    c = EnrichrClient()
    c._http = httpx.Client(transport=httpx.MockTransport(handler))
    assert c.get_pathways(["CDK1", "CCNB1"])
    assert attempts["addList"] == 3


def test_persistent_429_eventually_fails(monkeypatch):
    monkeypatch.setattr(enrichr_client.time, "sleep", lambda _s: None)
    c = EnrichrClient()
    c._http = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(429)))
    with pytest.raises(PathwayLookupError):
        c.get_pathways(["CDK1"])
