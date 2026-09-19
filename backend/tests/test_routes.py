import io

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from app.api.routes import router
from app.services.predictor import PredictionInputError, REFERENCE_SCOPE


class FailingPredictor:
    mode = "demo"
    model_version = "fake-v1"
    reference_scope = REFERENCE_SCOPE
    panel_size = 1
    is_loaded = True

    def __init__(self, error):
        self.error = error
        self.called = False
        self.sample_metadata = None

    def predict(self, image_bytes, sample_metadata):
        self.called = True
        self.sample_metadata = sample_metadata
        raise self.error


class RealPredictor(FailingPredictor):
    mode = "real"


def _png_bytes():
    buffer = io.BytesIO()
    Image.new("RGB", (224, 224), (160, 40, 120)).save(buffer, format="PNG")
    return buffer.getvalue()


def _client(predictor):
    app = FastAPI()
    app.state.predictor = predictor
    app.include_router(router, prefix="/api")
    return TestClient(app)


def test_invalid_decoded_image_maps_to_stable_400():
    predictor = FailingPredictor(RuntimeError("should not run"))
    response = _client(predictor).post(
        "/api/predict",
        files={"file": ("sample.png", b"not-an-image", "image/png")},
    )
    assert response.status_code == 400
    assert response.json() == {"detail": "The upload is not a valid decodable image"}
    assert predictor.called is False


def test_known_prediction_input_error_maps_to_422():
    predictor = FailingPredictor(PredictionInputError("No tissue was detected"))
    response = _client(predictor).post(
        "/api/predict",
        files={"file": ("sample.png", _png_bytes(), "image/png")},
    )
    assert response.status_code == 422
    assert response.json() == {"detail": "No tissue was detected"}


def test_internal_exception_details_are_not_returned():
    predictor = FailingPredictor(RuntimeError("secret filesystem path"))
    response = _client(predictor).post(
        "/api/predict",
        files={"file": ("sample.png", _png_bytes(), "image/png")},
    )
    assert response.status_code == 500
    assert response.json() == {"detail": "Prediction could not be completed"}
    assert "secret" not in response.text


def test_real_mode_requires_scientific_sample_metadata():
    predictor = RealPredictor(RuntimeError("should not run"))
    response = _client(predictor).post(
        "/api/predict",
        files={"file": ("sample.png", _png_bytes(), "image/png")},
    )
    assert response.status_code == 422
    assert response.json() == {"detail": "Real mode requires confirmation of HER2-positive breast tissue"}
    assert predictor.called is False


def test_real_mode_accepts_and_normalizes_required_multipart_metadata():
    predictor = RealPredictor(PredictionInputError("stop after capture"))
    response = _client(predictor).post(
        "/api/predict",
        files={"file": ("sample.png", _png_bytes(), "image/png")},
        data={
            "her2_positive_breast_tissue": "yes",
            "stain": "H&E",
            "microns_per_pixel": "0.5",
        },
    )
    assert response.status_code == 422
    assert predictor.called is True
    assert predictor.sample_metadata == {
        "her2_positive_breast_tissue": True,
        "stain": "H&E",
        "microns_per_pixel": 0.5,
    }


def test_unsupported_content_type_maps_to_415():
    predictor = FailingPredictor(RuntimeError("should not run"))
    response = _client(predictor).post(
        "/api/predict",
        files={"file": ("sample.gif", b"gif", "image/gif")},
    )
    assert response.status_code == 415
    assert predictor.called is False
