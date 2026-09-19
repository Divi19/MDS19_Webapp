import csv
import io
import json
import zipfile
from datetime import datetime, timezone

import h5py
from PIL import Image

from app.models.schemas import ExportRequest, PredictionResponse
from app.services.export import domain_markers_csv, domain_summary_csv, export_bundle, expression_csv, gene_summary_csv, h5ad_bytes, manifest_json, prediction_response_json, research_report_html, roi_geojson
from app.services.predictor import DummyPredictor


def _prediction():
    image = io.BytesIO()
    Image.new("RGB", (224, 224), (160, 40, 120)).save(image, format="PNG")
    predictor = DummyPredictor(grid_size=3)
    predictor.load()
    result = predictor.predict(image.getvalue())
    return PredictionResponse(prediction_id="prediction-1", status="complete", created_at=datetime(2025, 1, 1, tzinfo=timezone.utc), **result)


def _request():
    return ExportRequest(
        prediction=_prediction(),
        roi_geometries=[{
            "roi_id": "roi-a",
            "tile_indices": [0, 1],
            "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [2, 0], [2, 2], [0, 0]]]},
            "properties": {"name": "A"},
        }],
    )


def test_csv_json_and_geojson_exports_are_interoperable():
    request = _request()
    rows = list(csv.reader(io.StringIO(expression_csv(request.prediction).decode())))
    assert rows[0][:5] == ["tile_index", "spot_index", "x_original_pixels", "y_original_pixels", "predicted_expression_domain"]
    assert len(rows) == len(request.prediction.prediction_tiles) + 1
    assert len(list(csv.reader(io.StringIO(gene_summary_csv(request.prediction).decode())))) == request.prediction.model_metadata.panel_size + 1
    assert len(list(csv.reader(io.StringIO(domain_summary_csv(request.prediction).decode())))) > 1
    assert len(list(csv.reader(io.StringIO(domain_markers_csv(request.prediction).decode())))) > 1
    manifest = json.loads(manifest_json(request.prediction))
    assert manifest["prediction_id"] == "prediction-1"
    assert "expression" not in manifest
    geojson = json.loads(roi_geojson(request))
    assert geojson["type"] == "FeatureCollection"
    assert geojson["features"][0]["properties"]["tile_indices"] == [0, 1]


def test_h5ad_contains_raw_prediction_coordinates_domains_and_metadata():
    prediction = _prediction()
    content = h5ad_bytes(prediction)
    with h5py.File(io.BytesIO(content), "r") as handle:
        assert handle.attrs["encoding-type"] == "anndata"
        assert handle["X"].shape == (9, 15)
        assert handle["obsm/spatial"].shape == (9, 2)
        assert "predicted_expression_domain" in handle["obs"]
        assert "raw_predicted_expression" in handle["layers"]
        assert "provenance_manifest_json" in handle["uns"]
        expected = prediction.prediction_tiles[0].expression[next(iter(prediction.prediction_tiles[0].expression))]
        assert handle["X"][0, 0] == expected


def test_complete_prediction_json_and_research_report_are_truthful():
    prediction = _prediction()
    assert json.loads(prediction_response_json(prediction)) == prediction.model_dump(mode="json")
    report = research_report_html(prediction).decode()
    assert "Scope and applicability" in report
    assert "Quality control" in report
    assert "Model and retrieval methods" in report
    assert "Analysis methods" in report
    assert "Warnings and limitations" in report
    assert "Gene summary" in report
    assert "Predicted-expression domain summaries" in report
    assert "Provenance" in report
    assert "Research use only" in report
    assert "predicted, not measured" in report
    assert "not a diagnosis" in report
    assert "not cell types" in report
    assert "not equivalent to a laboratory measurement" in report
    assert "does not provide calibrated confidence" in report


def test_zip_bundle_contains_all_interoperable_artifacts_deterministically():
    request = _request()
    content = export_bundle(request)
    assert content == export_bundle(request)
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        assert set(archive.namelist()) == {
            "expression.csv",
            "gene_summary.csv",
            "domain_summary.csv",
            "domain_markers.csv",
            "manifest.json",
            "prediction-response.json",
            "research-report.html",
            "roi.geojson",
            "prediction.h5ad",
        }
        assert json.loads(archive.read("manifest.json"))["analysis_method"]["result_type"] == "predicted-expression domains"
        exported_prediction = json.loads(archive.read("prediction-response.json"))
        assert exported_prediction == request.prediction.model_dump(mode="json")
        assert b"Raw model-scale predicted-expression summaries" in archive.read("research-report.html")
