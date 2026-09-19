import io
from datetime import datetime, timezone

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from app.api.routes import router
from app.models.schemas import ExportRequest, PredictionResponse
from app.services.predictor import DummyPredictor


class PanelPredictor:
    genes = [f"G{index:03d}" for index in range(785)]


def _app():
    app = FastAPI()
    app.state.predictor = PanelPredictor()
    app.include_router(router, prefix="/api")
    return app


def _tiles():
    return [
        {"spot_index": index, "tile_index": index, "x": float(index), "y": 0.0, "expression": {"A": float(index), "B": float(index % 2)}}
        for index in range(6)
    ]


def _export_payload():
    image = io.BytesIO()
    Image.new("RGB", (224, 224), (160, 40, 120)).save(image, format="PNG")
    predictor = DummyPredictor(grid_size=2)
    predictor.load()
    result = predictor.predict(image.getvalue())
    prediction = PredictionResponse(prediction_id="p", status="complete", created_at=datetime.now(timezone.utc), **result)
    return ExportRequest(prediction=prediction).model_dump(mode="json")


def test_roi_endpoint_and_stable_overlap_error():
    client = TestClient(_app())
    payload = {"prediction_tiles": _tiles(), "group_a_tile_indices": [0, 2, 4], "group_b_tile_indices": [1, 3, 5], "permutations": 9}
    response = client.post("/api/analysis/roi", json=payload)
    assert response.status_code == 200
    assert response.json()["group_a_size"] == 3
    payload["group_b_tile_indices"] = [2, 3, 5]
    response = client.post("/api/analysis/roi", json=payload)
    assert response.status_code == 422
    assert response.json() == {"detail": "ROI_GROUPS_OVERLAP"}


def test_pathway_endpoint_uses_mocked_http_client():
    app = _app()
    app.state.pathway_client = httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"result": []})))
    try:
        response = TestClient(app).post("/api/analysis/pathways", json={"genes": ["G001"], "sources": ["GO:BP"]})
    finally:
        app.state.pathway_client.close()
    assert response.status_code == 200
    assert len(response.json()["background"]) == 785


def test_export_bundle_and_artifact_endpoints():
    client = TestClient(_app())
    payload = _export_payload()
    bundle = client.post("/api/analysis/exports/bundle", json=payload)
    assert bundle.status_code == 200
    assert bundle.headers["content-type"] == "application/zip"
    expression = client.post("/api/analysis/exports/expression.csv", json=payload)
    assert expression.status_code == 200
    assert expression.headers["content-type"].startswith("text/csv")
    assert expression.text.startswith("tile_index,spot_index")
