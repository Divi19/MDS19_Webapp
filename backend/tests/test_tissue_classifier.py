"""Acceptance tests for the vendored tissue-v1 inference module."""
import numpy as np

from app.services import tissue_classifier


def test_acceptance_b1_matches_expected_probs(tissue_stage_dir, acceptance_b1):
    model = tissue_classifier.load(str(tissue_stage_dir))
    out = tissue_classifier.predict_tissue(
        model, acceptance_b1["native"], acceptance_b1["wide672"], acceptance_b1["coords"])

    assert out["probs"].shape == acceptance_b1["expected_probs"].shape == (295, 6)
    assert np.max(np.abs(out["probs"] - acceptance_b1["expected_probs"])) < 1e-6
    assert len(out["labels"]) == 295


def test_large_slide_does_not_build_neighbour_matrix(tissue_stage_dir, monkeypatch):
    model = tissue_classifier.load(str(tissue_stage_dir))
    assert not model["cfg"]["nbr"] and model["cfg"]["alpha"] == 0.0

    def fail(*args, **kwargs):
        raise AssertionError("neighbour_matrix must not be built for this stage")

    monkeypatch.setattr(tissue_classifier, "neighbour_matrix", fail)

    n = 20_000
    rng = np.random.default_rng(0)
    native = rng.standard_normal((n, 1536), dtype=np.float32)
    wide = rng.standard_normal((n, 1536), dtype=np.float32)
    side = int(np.ceil(np.sqrt(n)))
    coords = np.stack(np.divmod(np.arange(n), side), axis=1).astype(np.float64)

    out = tissue_classifier.predict_tissue(model, native, wide, coords)

    assert out["probs"].shape == (n, 6)
    np.testing.assert_allclose(out["probs"].sum(1), 1.0, atol=1e-6)
