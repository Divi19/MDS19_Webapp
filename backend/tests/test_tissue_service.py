"""Tests for the app-side tissue layer: loading checks, Cancer merge,
summary, and the never-break-a-prediction guarantee."""
import copy
import json
import shutil

import numpy as np
import pytest

from app.services import tissue
from app.services.tissue import (
    DISPLAY_CLASSES, TissueClassifier, attach_tissue, load_tissue_classifier,
    merge_display_probs, summarize,
)


def test_merge_sums_cancer_and_keeps_other_classes():
    rng = np.random.default_rng(1)
    raw = rng.random((50, 6))
    raw /= raw.sum(1, keepdims=True)

    display = merge_display_probs(raw)

    assert display.shape == (50, 5)
    np.testing.assert_allclose(display[:, 0], raw[:, 0] + raw[:, 1])
    np.testing.assert_allclose(display[:, 1:], raw[:, 2:])
    np.testing.assert_allclose(display.sum(1), 1.0, atol=1e-6)


def test_summary_counts_every_display_class():
    display = np.array([
        [0.9, 0.05, 0.05, 0.0, 0.0],
        [0.8, 0.1, 0.1, 0.0, 0.0],
        [0.1, 0.1, 0.1, 0.1, 0.6],
    ])
    summary = summarize(display)

    assert list(summary) == DISPLAY_CLASSES
    assert summary["Cancer"] == {"count": 2, "fraction": pytest.approx(2 / 3)}
    assert summary["Adipose tissue"]["count"] == 1
    assert summary["Breast glands"] == {"count": 0, "fraction": 0.0}


def test_classify_on_acceptance_slide(tissue_stage_dir, acceptance_b1):
    clf = TissueClassifier.load(str(tissue_stage_dir))
    out = clf.classify(acceptance_b1["native"], acceptance_b1["wide672"], acceptance_b1["coords"])

    expected = merge_display_probs(acceptance_b1["expected_probs"])
    assert out["version"] == "tissue-v1"
    assert len(out["spots"]) == 295
    for spot, row in zip(out["spots"], expected):
        probs = np.array([spot["tissue_probs"][name] for name in DISPLAY_CLASSES])
        np.testing.assert_allclose(probs, row, atol=1e-6)
        assert abs(probs.sum() - 1.0) < 1e-6
        assert spot["tissue_class"] == DISPLAY_CLASSES[int(row.argmax())]
        assert spot["tissue_confidence"] == pytest.approx(row.max())
    assert sum(entry["count"] for entry in out["summary"].values()) == 295


def test_classify_rejects_mismatched_features(tissue_stage_dir):
    clf = TissueClassifier.load(str(tissue_stage_dir))
    with pytest.raises(ValueError):
        clf.classify(np.zeros((3, 1536)), np.zeros((3, 768)), np.zeros((3, 2)))


@pytest.mark.parametrize("change", [
    {"version": "tissue-v0"},
    {"classes": list(reversed(tissue.RAW_CLASSES))},
    {"expr": True},
])
def test_wrong_stage_disables_feature(tmp_path, tissue_stage_dir, change):
    shutil.copy(tissue_stage_dir / "tissue_clf.npz", tmp_path)
    cfg = json.loads((tissue_stage_dir / "stage_config.json").read_text())
    cfg.update(change)
    (tmp_path / "stage_config.json").write_text(json.dumps(cfg))

    assert load_tissue_classifier(True, str(tmp_path)) is None


def test_missing_stage_or_disabled_flag_returns_none(tmp_path, tissue_stage_dir):
    assert load_tissue_classifier(True, str(tmp_path / "nowhere")) is None
    assert load_tissue_classifier(False, str(tissue_stage_dir)) is None


def _prediction(n=4):
    return {
        "spots": [{"spot_index": i, "x": float(i), "y": 0.0, "expression": {"ERBB2": 1.0 + i}}
                  for i in range(n)],
        "top_genes": [{"gene_name": "ERBB2", "mean_expression": 2.5, "rank": 1}],
        "model_version": "test",
    }


class _RaisingClassifier:
    def classify(self, *args):
        raise RuntimeError("boom")


def test_classifier_failure_keeps_expression_and_nulls_tissue():
    result = _prediction()
    before = copy.deepcopy(result)
    features = lambda: (np.zeros((4, 1536)), np.zeros((4, 1536)))

    attach_tissue(result, _RaisingClassifier(), features, np.zeros((4, 2)))

    assert result["tissue_model_version"] is None and result["tissue_summary"] is None
    for spot, original in zip(result["spots"], before["spots"]):
        assert spot["expression"] == original["expression"]
        assert spot["tissue_class"] is None and spot["tissue_probs"] is None
    assert result["top_genes"] == before["top_genes"]


def test_feature_failure_is_contained(tissue_stage_dir):
    clf = TissueClassifier.load(str(tissue_stage_dir))
    result = _prediction()

    def features():
        raise OSError("H0-mini weights unavailable")

    attach_tissue(result, clf, features, np.zeros((4, 2)))
    assert result["tissue_summary"] is None
    assert all(spot["tissue_confidence"] is None for spot in result["spots"])


def test_attach_fills_fields_on_success(tissue_stage_dir, acceptance_b1):
    clf = TissueClassifier.load(str(tissue_stage_dir))
    result = _prediction(295)
    attach_tissue(result, clf, lambda: (acceptance_b1["native"], acceptance_b1["wide672"]),
                  acceptance_b1["coords"])

    assert result["tissue_model_version"] == "tissue-v1"
    assert set(result["tissue_summary"]) == set(DISPLAY_CLASSES)
    assert all(spot["tissue_class"] in DISPLAY_CLASSES for spot in result["spots"])
