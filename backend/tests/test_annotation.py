import httpx
import pytest

from app.services.annotation import GPROFILER_API_VERSION, PathwayUpstreamError, enrich_pathways


def _panel():
    return [f"G{index:03d}" for index in range(785)]


def test_mocked_gprofiler_response_uses_versioned_deterministic_request():
    def handler(request):
        assert GPROFILER_API_VERSION in str(request.url)
        payload = __import__("json").loads(request.content)
        assert payload["query"] == ["G001", "G002"]
        assert payload["background"] == sorted(_panel())
        assert payload["domain_scope"] == "custom"
        return httpx.Response(200, json={"result": [{"source": "GO:BP", "native": "GO:1", "name": "term", "p_value": 0.02, "intersection": ["G002", "G001"]}]})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = enrich_pathways(["G002", "G001"], _panel(), ["GO:BP"], client)
    assert result["query"] == ["G001", "G002"]
    assert result["terms"] == [{
        "source": "GO:BP",
        "term_id": "GO:1",
        "term_name": "term",
        "adjusted_p_value": 0.02,
        "contributing_genes": ["G001", "G002"],
    }]
    assert len(result["background"]) == 785
    assert result["timestamp"].tzinfo is not None


@pytest.mark.parametrize(
    ("response", "status_code", "code"),
    [
        (httpx.Response(500, json={}), 503, "PATHWAY_UPSTREAM_UNAVAILABLE"),
        (httpx.Response(200, json={"wrong": []}), 502, "PATHWAY_INVALID_UPSTREAM_RESPONSE"),
    ],
)
def test_mocked_gprofiler_failures_are_graceful(response, status_code, code):
    with httpx.Client(transport=httpx.MockTransport(lambda request: response)) as client:
        with pytest.raises(PathwayUpstreamError) as caught:
            enrich_pathways(["G001"], _panel(), ["GO:BP"], client)
    assert caught.value.status_code == status_code
    assert caught.value.code == code
