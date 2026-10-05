"""API contract tests for the additive, nullable tissue fields."""
import io

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from app.api.routes import router
from app.models.schemas import PredictionResponse
from app.services.tissue import DISPLAY_CLASSES, attach_tissue


OLD_PAYLOAD = {
    "prediction_id": "00000000-0000-0000-0000-000000000000",
    "status": "complete",
    "model_version": "mclstexp-her2st-best_0+smooth0.6",
    "created_at": "2026-09-29T12:00:00Z",
    "spots": [{"spot_index": 0, "x": 1.0, "y": 2.0, "expression": {"ERBB2": 1.2}}],
    "top_genes": [{"gene_name": "ERBB2", "mean_expression": 1.2, "rank": 1}],
}


def test_old_payload_still_validates_with_null_tissue_fields():
    response = PredictionResponse.model_validate(OLD_PAYLOAD)
    assert response.tissue_model_version is None
    assert response.tissue_summary is None
    assert response.spots[0].tissue_class is None
    assert response.spots[0].tissue_probs is None


def test_new_payload_round_trips():
    payload = dict(OLD_PAYLOAD)
    probs = {name: 0.2 for name in DISPLAY_CLASSES}
    payload["spots"] = [{**OLD_PAYLOAD["spots"][0], "tissue_class": "Cancer",
                         "tissue_confidence": 0.2, "tissue_probs": probs}]
    payload["tissue_model_version"] = "tissue-v1"
    payload["tissue_summary"] = {name: {"count": 0, "fraction": 0.0} for name in DISPLAY_CLASSES}

    dumped = PredictionResponse.model_validate(payload).model_dump(mode="json")
    assert dumped["spots"][0]["tissue_probs"] == probs
    assert dumped["tissue_summary"]["Cancer"] == {"count": 0, "fraction": 0.0}


class _FakePredictor:
    """Expression output plus a tissue step that can be made to fail."""

    is_loaded = True
    tissue_model_version = "tissue-v1"

    def __init__(self, classifier):
        self.classifier = classifier

    def predict(self, image_bytes):
        result = {
            "spots": [{"spot_index": i, "x": float(i), "y": 0.0,
                       "expression": {"ERBB2": 1.0 + i, "CD74": 0.5}} for i in range(3)],
            "top_genes": [{"gene_name": "ERBB2", "mean_expression": 2.0, "rank": 1}],
            "model_version": "fake",
        }
        features = lambda: (np.zeros((3, 1536)), np.zeros((3, 1536)))
        return attach_tissue(result, self.classifier, features, np.zeros((3, 2)))


class _Raising:
    def classify(self, *args):
        raise RuntimeError("classifier exploded")


class _Fixed:
    def classify(self, native, wide672, coords):
        row = {"tissue_class": "Cancer", "tissue_confidence": 0.7,
               "tissue_probs": {name: (0.7 if name == "Cancer" else 0.075) for name in DISPLAY_CLASSES}}
        return {"spots": [dict(row) for _ in coords], "version": "tissue-v1",
                "summary": {name: {"count": 3 if name == "Cancer" else 0,
                                   "fraction": 1.0 if name == "Cancer" else 0.0}
                            for name in DISPLAY_CLASSES}}


def _client(classifier):
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.state.predictor = _FakePredictor(classifier)
    return TestClient(app)


def _png() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (8, 8), "pink").save(buffer, format="PNG")
    return buffer.getvalue()


@pytest.mark.parametrize("classifier", [None, _Raising()])
def test_predict_returns_full_expression_with_null_tissue(classifier):
    body = _client(classifier).post(
        "/api/predict", files={"file": ("x.png", _png(), "image/png")}).json()

    assert [s["expression"]["ERBB2"] for s in body["spots"]] == [1.0, 2.0, 3.0]
    assert body["top_genes"][0]["gene_name"] == "ERBB2"
    assert body["tissue_model_version"] is None and body["tissue_summary"] is None
    assert all(s["tissue_class"] is None and s["tissue_probs"] is None for s in body["spots"])


def test_predict_returns_tissue_fields_when_classifier_runs():
    client = _client(_Fixed())
    body = client.post("/api/predict", files={"file": ("x.png", _png(), "image/png")}).json()

    assert body["tissue_model_version"] == "tissue-v1"
    assert body["tissue_summary"]["Cancer"] == {"count": 3, "fraction": 1.0}
    assert body["spots"][0]["tissue_class"] == "Cancer"
    assert set(body["spots"][0]["tissue_probs"]) == set(DISPLAY_CLASSES)
    assert client.get("/api/health").json()["tissue_model_version"] == "tissue-v1"
