"""Multi-cancer Grad-CAM: the prediction's tissue code reaches the Modal
Grad-CAM endpoint, and nothing changes when it is absent."""
import base64
import inspect
import io
import json

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from app.api.routes import router
from app.services.gradcam import TileResult
from app.services.modal_predictor import ModalPredictor
from app.services.predictor import BasePredictor, MclSTExpPredictor

PNG = b"\x89PNG fake"


def _tile(i):
    return {"spot_index": i, "png_base64": base64.b64encode(PNG).decode("ascii"), "peak": 0.5}


def _modal(extra=None):
    """A ModalPredictor wired to a fake Modal Grad-CAM endpoint and no real Supabase."""
    sent = []

    def handler(request):
        body = json.loads(request.content)
        sent.append(body)
        return httpx.Response(200, json={"tiles": [_tile(i) for i in body["spot_indices"]],
                                         **(extra or {})})

    p = object.__new__(ModalPredictor)
    p.gradcam_url = "https://modal.test/gradcam"
    p.request_timeout = 5.0
    p._loaded = True
    p._http = httpx.Client(transport=httpx.MockTransport(handler))
    p._stage_for_gradcam = lambda image_bytes: "https://signed.test/slide.bin"
    return p, sent


# --- ModalPredictor relay ---------------------------------------------------

def test_modal_gradcam_body_is_unchanged_without_tissue():
    p, sent = _modal()
    p.explain_batch(b"img", [0, 1], "ERBB2")
    assert sent == [{"image_url": "https://signed.test/slide.bin",
                     "spot_indices": [0, 1], "gene": "ERBB2"}]


def test_modal_gradcam_forwards_tissue():
    # The multi-cancer app also reports tissue/model/stride_px; tiles parse as before.
    p, sent = _modal({"tissue": "COAD", "model": "COAD", "stride_px": 145})
    tiles = p.explain_batch(b"img", [3], None, tissue="COAD")
    assert sent[0]["tissue"] == "COAD"
    assert [t.png for t in tiles] == [PNG]


def test_modal_single_explain_forwards_tissue():
    p, sent = _modal()
    assert p.explain(b"img", 2, "CEACAM5", tissue="COAD") == PNG
    assert sent[0]["spot_indices"] == [2] and sent[0]["tissue"] == "COAD"


def test_every_predictor_accepts_tissue_on_explain():
    for cls in (BasePredictor, MclSTExpPredictor, ModalPredictor):
        for name in ("explain", "explain_batch"):
            assert "tissue" in inspect.signature(getattr(cls, name)).parameters, (cls, name)


# --- /api/predict/gradcam[/batch] -------------------------------------------

class _Recorder:
    is_loaded = True

    def __init__(self):
        self.calls = []

    def explain(self, image_bytes, spot_index, gene=None, tissue=None):
        self.calls.append(("explain", spot_index, gene, tissue))
        return PNG

    def explain_batch(self, image_bytes, spot_indices, gene=None, tissue=None):
        self.calls.append(("batch", spot_indices, gene, tissue))
        return [TileResult(png=PNG, peak=0.5) for _ in spot_indices]


def _post(path, data):
    p = _Recorder()
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.state.predictor = p
    buf = io.BytesIO()
    Image.new("RGB", (8, 8)).save(buf, format="PNG")
    resp = TestClient(app).post(path, data=data,
                                files={"file": ("t.png", buf.getvalue(), "image/png")})
    assert resp.status_code == 200, resp.text
    return p.calls


@pytest.mark.parametrize("form, expected", [
    ({}, None),
    ({"tissue": "COAD"}, "COAD"),
    ({"tissue": "  "}, None),
])
def test_batch_route_passes_tissue(form, expected):
    calls = _post("/api/predict/gradcam/batch", {"spot_indices": "0,1", "gene": "ERBB2", **form})
    assert calls == [("batch", [0, 1], "ERBB2", expected)]


def test_single_route_passes_tissue():
    calls = _post("/api/predict/gradcam", {"spot_index": "4", "tissue": "IDC"})
    assert calls == [("explain", 4, None, "IDC")]
