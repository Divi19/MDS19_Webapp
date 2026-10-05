"""
End-to-end predictor test on the local reference bank: the tissue step adds
fields without changing a single expression value, and a failing tissue step
returns the full expression output with null tissue fields.

Skipped when the expression bank (backend/model_data/webapp_database) is
absent. H0-mini itself is gated, so its features are stubbed here; the real
feature path is the same arrays the encoder returns.
"""
import io
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from app.services.tissue import DISPLAY_CLASSES, TissueClassifier

BANK = Path(__file__).resolve().parents[1] / "model_data" / "webapp_database"


@pytest.fixture(scope="module")
def predictor():
    if not (BANK / "best_0.pt").is_file():
        pytest.skip(f"expression reference bank not found in {BANK}")
    from app.services.predictor import MclSTExpPredictor

    p = MclSTExpPredictor(str(BANK / "best_0.pt"), str(BANK), encoder_backend="densenet121")
    p.load()
    return p


@pytest.fixture(scope="module")
def slide_bytes():
    rng = np.random.default_rng(3)
    pixels = np.clip(rng.normal([210, 120, 180], 25, size=(448, 672, 3)), 0, 255).astype(np.uint8)
    buffer = io.BytesIO()
    Image.fromarray(pixels).save(buffer, format="PNG")
    return buffer.getvalue()


class _StubExtractor:
    def features(self, patches, context_patches):
        assert len(patches) == len(context_patches)
        rng = np.random.default_rng(len(patches))
        return (rng.standard_normal((len(patches), 1536)),
                rng.standard_normal((len(patches), 1536)))


class _BrokenExtractor:
    def features(self, patches, context_patches):
        raise OSError("gated weights unavailable")


def _expression(result):
    return [spot["expression"] for spot in result["spots"]]


def test_tissue_step_never_changes_expression(predictor, slide_bytes, tissue_stage_dir):
    predictor._tissue, predictor._tissue_extractor = None, None
    baseline = predictor.predict(slide_bytes)
    assert baseline["tissue_summary"] is None
    assert all(s["tissue_class"] is None for s in baseline["spots"])

    predictor._tissue = TissueClassifier.load(str(tissue_stage_dir))
    predictor._tissue_extractor = _StubExtractor()
    with_tissue = predictor.predict(slide_bytes)

    assert _expression(with_tissue) == _expression(baseline)
    assert with_tissue["top_genes"] == baseline["top_genes"]
    assert with_tissue["model_version"] == baseline["model_version"]
    assert with_tissue["tissue_model_version"] == "tissue-v1"
    assert sum(v["count"] for v in with_tissue["tissue_summary"].values()) == len(with_tissue["spots"])
    for spot in with_tissue["spots"]:
        assert spot["tissue_class"] in DISPLAY_CLASSES
        assert abs(sum(spot["tissue_probs"].values()) - 1.0) < 1e-6

    predictor._tissue_extractor = _BrokenExtractor()
    broken = predictor.predict(slide_bytes)
    assert _expression(broken) == _expression(baseline)
    assert broken["tissue_summary"] is None and broken["tissue_model_version"] is None
    assert all(s["tissue_probs"] is None for s in broken["spots"])


def test_h0mini_path_reuses_expression_features():
    from app.services.predictor import MclSTExpPredictor

    p = MclSTExpPredictor("unused.pt", "unused", encoder_backend="h0mini")
    native, context = np.ones((2, 1536)), np.zeros((2, 1536))
    got = p._tissue_features(None, None, [(0, 0), (1, 0)], native, context)
    assert got[0] is native and got[1] is context
