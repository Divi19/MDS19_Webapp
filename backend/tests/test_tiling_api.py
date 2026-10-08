"""The predict response carries how spot grid indices map to image pixels."""
import io

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from app.api.routes import router
from app.services.predictor import MclSTExpPredictor


class _Predictor:
    is_loaded = True

    def __init__(self, extra):
        self.extra = extra

    def predict(self, image_bytes):
        return {
            "spots": [{"spot_index": 0, "x": 3.0, "y": 2.0, "expression": {"ERBB2": 1.0}}],
            "top_genes": [{"gene_name": "ERBB2", "mean_expression": 1.0, "rank": 1}],
            "model_version": "fake",
            **self.extra,
        }


def _post(predictor):
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.state.predictor = predictor
    buf = io.BytesIO()
    Image.new("RGB", (8, 8)).save(buf, format="PNG")
    return TestClient(app).post("/api/predict", files={"file": ("t.png", buf.getvalue(), "image/png")}).json()


def test_tiling_from_the_predictor_passes_through():
    # e.g. the v7 Modal model: 224 px crops every 290 px.
    body = _post(_Predictor({"tile_px": 224, "stride_px": 290}))
    assert (body["tile_px"], body["stride_px"]) == (224, 290)


def test_tiling_is_null_when_the_predictor_does_not_report_it():
    body = _post(_Predictor({}))
    assert body["tile_px"] is None and body["stride_px"] is None


def test_local_predictor_reports_its_own_tiling():
    # The local MclSTExp backend tiles without gaps.
    assert (MclSTExpPredictor.PATCH, MclSTExpPredictor.STRIDE) == (224, 224)
