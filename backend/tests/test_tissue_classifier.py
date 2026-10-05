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
