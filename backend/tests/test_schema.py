import io
from datetime import datetime, timezone

from PIL import Image

from app.models.schemas import HealthResponse, PredictionResponse
from app.services.predictor import DummyPredictor, REFERENCE_SCOPE


def _png_bytes():
    buffer = io.BytesIO()
    Image.new("RGB", (224, 224), (160, 40, 120)).save(buffer, format="PNG")
    return buffer.getvalue()


def test_prediction_schema_exposes_canonical_tiles_and_compatibility_fields():
    predictor = DummyPredictor(grid_size=2)
    predictor.load()
    result = predictor.predict(_png_bytes())
    response = PredictionResponse(
        prediction_id="prediction-1",
        status="complete",
        created_at=datetime.now(timezone.utc),
        **result,
    )
    assert len(response.prediction_tiles) == 4
    assert len(response.spots) == 4
    assert response.model_metadata.output_type == "prediction_tiles"
    assert response.coordinate_metadata.x_y_units == "demo_grid_units"
    assert response.all_gene_summary.authoritative is True
    assert response.all_gene_summary.statistics == ["mean", "variance"]
    assert len(response.all_gene_summary.genes) == response.model_metadata.panel_size
    assert len(response.spatial_statistics.genes) == response.model_metadata.panel_size
    assert len(response.domain_assignments) == len(response.prediction_tiles)
    assert response.analysis_method.result_type == "predicted-expression domains"
    assert response.embeddings.method == "PCA"


def test_health_schema_includes_scientific_scope():
    health = HealthResponse(
        status="ok",
        model_loaded=True,
        predictor_type="DummyPredictor",
        mode="demo",
        model_version="dummy-v1",
        reference_scope=REFERENCE_SCOPE,
        panel_size=15,
    )
    assert health.reference_scope == REFERENCE_SCOPE
    assert health.panel_size == 15
