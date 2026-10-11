"""Multi-cancer serving: the tissue override, the "not supported" refusal and
the new response fields, through /api/predict and the Modal relay."""
import io
import json

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from app.api.routes import router
from app.services.errors import TissueNotSupportedError
from app.services.modal_predictor import ModalPredictor
from app.services.predictor import BasePredictor, DummyPredictor

COAD_VERDICT = {
    "code": "COAD", "label": "Colon adenocarcinoma", "prob": 0.94,
    "supported": True, "reason": None, "limited_support": False, "overridden": False,
}
UNSUPPORTED_VERDICT = {
    "code": "OTHER", "label": "Unknown tissue", "prob": 0.41,
    "supported": False, "reason": "far from every training cancer",
}


def _result(**extra):
    return {
        "spots": [{"spot_index": 0, "x": 1.0, "y": 2.0, "expression": {"CEACAM5": 1.0}}],
        "top_genes": [{"gene_name": "CEACAM5", "mean_expression": 1.0, "rank": 1}],
        "model_version": "fake",
        **extra,
    }


class _Plain:
    """A predictor from before multi-cancer: predict(image_bytes) only."""
    is_loaded = True

    def predict(self, image_bytes):
        return _result()


class _MultiCancer:
    is_loaded = True
    supports_tissue_override = True

    def __init__(self, raises=None):
        self.raises = raises
        self.calls = []

    def predict(self, image_bytes, tissue=None):
        self.calls.append(tissue)
        if self.raises:
            raise self.raises
        verdict = dict(COAD_VERDICT, overridden=tissue is not None)
        return _result(tissue=verdict, expression_units="log1p(counts / spot total x 1e4)",
                       limited_support=False, tile_px=224, stride_px=145)


def _post(predictor, data=None):
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.state.predictor = predictor
    buf = io.BytesIO()
    Image.new("RGB", (8, 8)).save(buf, format="PNG")
    return TestClient(app).post(
        "/api/predict", data=data or {},
        files={"file": ("t.png", buf.getvalue(), "image/png")})


# --- /api/predict -----------------------------------------------------------

def test_without_tissue_old_predictors_work_and_new_fields_are_null():
    resp = _post(_Plain())
    assert resp.status_code == 200
    body = resp.json()
    assert body["tissue"] is None
    assert body["expression_units"] is None
    assert body["limited_support"] is None


def test_tissue_override_is_rejected_by_predictors_that_do_not_support_it():
    resp = _post(_Plain(), {"tissue": "COAD"})
    assert resp.status_code == 400
    assert "not supported by this deployment" in resp.json()["detail"]


def test_dummy_predictor_rejects_tissue_override():
    p = DummyPredictor(grid_size=2)
    p.load()
    assert _post(p, {"tissue": "COAD"}).status_code == 400


def test_blank_tissue_counts_as_no_override():
    assert _post(_Plain(), {"tissue": "  "}).status_code == 200


def test_tissue_override_reaches_the_predictor():
    p = _MultiCancer()
    body = _post(p, {"tissue": "COAD"}).json()
    assert p.calls == ["COAD"]
    assert body["tissue"]["overridden"] is True


def test_new_fields_pass_through():
    p = _MultiCancer()
    body = _post(p).json()
    assert p.calls == [None]
    assert body["tissue"]["code"] == "COAD"
    assert body["expression_units"].startswith("log1p")
    assert body["limited_support"] is False
    assert (body["tile_px"], body["stride_px"]) == (224, 145)


def test_unsupported_tissue_is_a_structured_422():
    p = _MultiCancer(raises=TissueNotSupportedError("Tissue not supported", UNSUPPORTED_VERDICT))
    resp = _post(p)
    assert resp.status_code == 422
    assert resp.json()["detail"] == {
        "code": "tissue_not_supported",
        "message": "Tissue not supported",
        "tissue": UNSUPPORTED_VERDICT,
    }


def test_only_the_modal_predictor_supports_tissue_override():
    assert BasePredictor.supports_tissue_override is False
    assert DummyPredictor.supports_tissue_override is False
    assert ModalPredictor.supports_tissue_override is True


# --- ModalPredictor relay ---------------------------------------------------

def _modal(reply):
    """A ModalPredictor wired to a fake Modal endpoint and no real Supabase."""
    sent, cleaned = [], []

    def handler(request):
        sent.append(json.loads(request.content))
        return httpx.Response(200, json=reply)

    p = object.__new__(ModalPredictor)
    p.predict_url = "https://modal.test/predict"
    p.request_timeout = 5.0
    p._loaded = True
    p._fallback_model_version = "fallback"
    p._http = httpx.Client(transport=httpx.MockTransport(handler))
    p._stage_upload = lambda image_bytes: ("relay.bin", "https://signed.test/relay.bin")
    p._cleanup = cleaned.append
    return p, sent, cleaned


def test_modal_body_is_unchanged_without_tissue():
    p, sent, _ = _modal(_result())
    p.predict(b"img")
    assert sent == [{"image_url": "https://signed.test/relay.bin"}]


def test_modal_body_carries_tissue_override():
    p, sent, _ = _modal(_result(tissue=COAD_VERDICT))
    result = p.predict(b"img", tissue="COAD")
    assert sent == [{"image_url": "https://signed.test/relay.bin", "tissue": "COAD"}]
    assert result["tissue"]["code"] == "COAD"


def test_modal_unsupported_reply_raises_and_still_cleans_up():
    p, _, cleaned = _modal({"unsupported": True, "message": "Not a supported cancer",
                            "tissue": UNSUPPORTED_VERDICT})
    with pytest.raises(TissueNotSupportedError) as info:
        p.predict(b"img")
    assert info.value.message == "Not a supported cancer"
    assert info.value.tissue == UNSUPPORTED_VERDICT
    assert cleaned == ["relay.bin"]


def test_modal_unsupported_reply_without_message_names_the_tissue():
    p, _, _ = _modal({"unsupported": True, "tissue": UNSUPPORTED_VERDICT})
    with pytest.raises(TissueNotSupportedError) as info:
        p.predict(b"img")
    assert "Unknown tissue" in info.value.message
    assert UNSUPPORTED_VERDICT["reason"] in info.value.message
