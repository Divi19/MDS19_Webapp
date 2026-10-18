"""PathwayDescriber: per-source lookup, HTML stripping, caching, errors."""
import httpx
import pytest

from app.services.david_client import PathwayLookupError
from app.services.pathway_description import PathwayDescriber


def _describer(calls, handler):
    d = PathwayDescriber()
    d._http = httpx.Client(transport=httpx.MockTransport(
        lambda req: (calls.append(req), handler(req))[1]))
    return d


def test_reactome_summary_is_plain_text_and_cached():
    calls = []
    d = _describer(calls, lambda r: httpx.Response(
        200, json={"summation": [{"text": "<p>GRB7 binds <b>ERBB2</b>.</p>"}]}))
    out = d.describe("REACTOME_PATHWAY", "R-HSA-1306955", "GRB7 events")
    assert out == {"description": "GRB7 binds ERBB2.",
                   "url": "https://reactome.org/content/detail/R-HSA-1306955"}
    d.describe("REACTOME_PATHWAY", "R-HSA-1306955", "GRB7 events")
    assert len(calls) == 1


def test_go_definition():
    calls = []
    d = _describer(calls, lambda r: httpx.Response(
        200, json={"results": [{"definition": {"text": "A cell cycle process."}}]}))
    out = d.describe("GOTERM_BP_FAT", "GO:0000278", "mitotic cell cycle")
    assert out["description"] == "A cell cycle process."
    assert out["url"].endswith("/GO:0000278")


def test_kegg_is_link_only_with_no_network():
    calls = []
    d = _describer(calls, lambda r: httpx.Response(500))
    out = d.describe("KEGG_PATHWAY", "", "Breast cancer")
    assert out["description"] is None and "Breast+cancer" in out["url"]
    assert calls == []


def test_not_found_gives_no_description():
    d = _describer([], lambda r: httpx.Response(404))
    assert d.describe("GOTERM_BP_FAT", "GO:0000278", "x")["description"] is None


def test_upstream_failure_raises_and_is_not_cached():
    d = _describer([], lambda r: httpx.Response(503))
    with pytest.raises(PathwayLookupError):
        d.describe("REACTOME_PATHWAY", "R-HSA-1", "x")
    assert d._cache == {}


def test_malformed_id_rejected():
    with pytest.raises(ValueError):
        _describer([], lambda r: httpx.Response(200)).describe(
            "REACTOME_PATHWAY", "../etc", "x")
