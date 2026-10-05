"""
Per-spot tissue-type classification (tissue-v1), layered on top of a
prediction without ever being able to break it.

The classifier itself (app/services/tissue_classifier.py) is a numpy-only
logistic regression over the SAME H0-mini features v7 retrieval uses:
native 224 crop (1536-d) ++ 672 context crop resized to 224 (1536-d). This
module adds what the app needs around it:

  - load-time checks on the stage (version, class order, no expression input);
  - merging the two cancer classes into one display class — the model cannot
    separate in situ from invasive (in situ F1 0.06), so users never see that
    split;
  - per-spot fields (class, confidence, 5 display probabilities) and a
    whole-prediction summary (count + fraction per display class);
  - attach_tissue(), which fills those fields on a finished prediction and,
    on ANY failure, logs and leaves them null. The expression result is never
    touched.

Artifacts (tissue_clf.npz + stage_config.json) are model files, so they live
next to the expression reference bank (backend/model_data/tissue_clf_v1/,
gitignored), not in git.
"""
from __future__ import annotations

import logging
import os
import time
from typing import Callable

import numpy as np

from app.services import tissue_classifier

logger = logging.getLogger(__name__)

TISSUE_MODEL_VERSION = "tissue-v1"
H0MINI_FEATURE_DIM = 1536

RAW_CLASSES = [
    "invasive cancer", "cancer in situ", "immune infiltrate",
    "breast glands", "connective tissue", "adipose tissue",
]
DISPLAY_CLASSES = [
    "Cancer", "Immune infiltrate", "Breast glands",
    "Connective tissue", "Adipose tissue",
]

# Per-spot fields this module owns. Present (as None) on every spot of a
# prediction that ran through attach_tissue(), whether or not it succeeded.
SPOT_FIELDS = ("tissue_class", "tissue_confidence", "tissue_probs")


class TissueClassifier:
    """A validated tissue-v1 stage, ready to classify one slide at a time."""

    def __init__(self, model: dict):
        self._model = model
        self.version = model["cfg"]["version"]

    @classmethod
    def load(cls, stage_dir: str) -> "TissueClassifier":
        """Raises if the stage is missing or is not the one this app expects."""
        model = tissue_classifier.load(stage_dir)
        cfg = model["cfg"]
        if cfg.get("version") != TISSUE_MODEL_VERSION:
            raise ValueError(f"expected version {TISSUE_MODEL_VERSION!r}, got {cfg.get('version')!r}")
        if cfg.get("classes") != RAW_CLASSES:
            raise ValueError(f"unexpected class list/order: {cfg.get('classes')!r}")
        if cfg.get("expr") is not False:
            # An expr=true stage would need v7's pre-smoothing retrieval output,
            # which the prediction path does not hand over.
            raise ValueError("stage needs predicted expression (expr != false)")
        return cls(model)

    def classify(self, native: np.ndarray, wide672: np.ndarray, coords: np.ndarray) -> dict:
        """
        native, wide672: (n_spots, 1536) H0-mini features, same spot order.
        coords: (n_spots, 2) tile grid indices (only read by stages that use
        neighbours; tissue-v1 does not).

        Returns {"spots": [per-spot fields], "summary": {...}, "version": str}.
        """
        native = np.asarray(native)
        wide672 = np.asarray(wide672)
        n = len(coords)
        expected = (n, H0MINI_FEATURE_DIM)
        if native.shape != expected or wide672.shape != expected:
            raise ValueError(
                f"feature shape mismatch: native {native.shape}, wide672 "
                f"{wide672.shape}, expected {expected}")

        raw = tissue_classifier.predict_tissue(self._model, native, wide672, coords)["probs"]
        display = merge_display_probs(raw)
        if not np.all(np.isfinite(display)) or np.max(np.abs(display.sum(1) - 1.0)) > 1e-6:
            raise ValueError("display probabilities are not a valid distribution")
        return {
            "spots": spot_fields(display),
            "summary": summarize(display),
            "version": self.version,
        }


def merge_display_probs(raw_probs: np.ndarray) -> np.ndarray:
    """(n, 6) raw class probabilities -> (n, 5) display probabilities, with
    Cancer = invasive + in situ. Every other class maps through unchanged."""
    raw_probs = np.asarray(raw_probs, dtype=np.float64)
    if raw_probs.ndim != 2 or raw_probs.shape[1] != len(RAW_CLASSES):
        raise ValueError(f"expected (n, {len(RAW_CLASSES)}) probabilities, got {raw_probs.shape}")
    return np.column_stack([raw_probs[:, 0] + raw_probs[:, 1], raw_probs[:, 2:]])


def spot_fields(display_probs: np.ndarray) -> list[dict]:
    best = display_probs.argmax(1)
    return [
        {
            "tissue_class": DISPLAY_CLASSES[int(best[i])],
            "tissue_confidence": float(row[best[i]]),
            "tissue_probs": {name: float(p) for name, p in zip(DISPLAY_CLASSES, row)},
        }
        for i, row in enumerate(display_probs)
    ]


def summarize(display_probs: np.ndarray) -> dict:
    """Count and fraction of spots per display class, over all spots. Every
    class is present (count 0 when absent) so the UI can render a fixed
    legend."""
    n = len(display_probs)
    counts = np.bincount(display_probs.argmax(1), minlength=len(DISPLAY_CLASSES)) if n else np.zeros(len(DISPLAY_CLASSES), int)
    return {
        name: {"count": int(counts[i]), "fraction": float(counts[i] / n) if n else 0.0}
        for i, name in enumerate(DISPLAY_CLASSES)
    }


def load_tissue_classifier(enabled: bool, stage_dir: str) -> TissueClassifier | None:
    """Startup loader that never raises: a missing or wrong stage disables
    the feature (tissue fields stay null) instead of failing the boot."""
    if not enabled:
        logger.info("tissue classifier disabled (TISSUE_CLASSIFIER_ENABLED=false)")
        return None
    try:
        classifier = TissueClassifier.load(stage_dir)
    except Exception:
        logger.exception("tissue classifier failed to load from %r — feature disabled", stage_dir)
        return None
    logger.info("tissue classifier %s loaded from %s", classifier.version, stage_dir)
    return classifier


def attach_tissue(
    result: dict,
    classifier: TissueClassifier | None,
    features: Callable[[], tuple[np.ndarray, np.ndarray]],
    coords,
) -> dict:
    """
    Fill the tissue fields on a finished prediction, in place.

    `features` is called lazily and must return (native, wide672) for the
    spots in result["spots"], in the same order — so feature extraction is
    inside the same failure boundary as classification. Any exception leaves
    every tissue field null and is logged; result["spots"][*]["expression"],
    top_genes and model_version are never modified.
    """
    for spot in result["spots"]:
        for field in SPOT_FIELDS:
            spot[field] = None
    result["tissue_model_version"] = None
    result["tissue_summary"] = None

    if classifier is None:
        return result
    try:
        started = time.perf_counter()
        native, wide672 = features()
        out = classifier.classify(native, wide672, np.asarray(coords, dtype=np.float64))
        if len(out["spots"]) != len(result["spots"]):
            raise ValueError(f"{len(out['spots'])} tissue rows for {len(result['spots'])} spots")
        for spot, fields in zip(result["spots"], out["spots"]):
            spot.update(fields)
        result["tissue_model_version"] = out["version"]
        result["tissue_summary"] = out["summary"]
        logger.info("tissue classification: %d spots in %.2fs",
                    len(result["spots"]), time.perf_counter() - started)
    except Exception:
        logger.exception("tissue classification failed — returning tissue fields as null")
        for spot in result["spots"]:
            for field in SPOT_FIELDS:
                spot[field] = None
        result["tissue_model_version"] = None
        result["tissue_summary"] = None
    return result


class H0MiniFeatureExtractor:
    """
    H0-mini native + 672-context features for predictors whose expression
    model does NOT already compute them (the densenet121 baseline used for
    local runs). On the v7/h0mini path the predictor hands over the features
    it already computed instead, so nothing is encoded twice.

    Needs access to the gated bioptimus/H0-mini weights: an HF_TOKEN in the
    environment (or passed in here) for an account that accepted its terms.
    """

    BATCH_SIZE = 16

    def __init__(self, device: str = "cpu", hf_token: str = ""):
        if hf_token and not os.environ.get("HF_TOKEN"):
            os.environ["HF_TOKEN"] = hf_token
        from app.services.encoders import H0MiniEncoder

        self._encoder = H0MiniEncoder(device)

    def _run(self, patches) -> np.ndarray:
        import torch

        out = []
        with torch.no_grad():
            for i in range(0, len(patches), self.BATCH_SIZE):
                out.append(self._encoder.encode(patches[i:i + self.BATCH_SIZE]).cpu().numpy())
        return np.concatenate(out, axis=0)

    def features(self, patches, context_patches) -> tuple[np.ndarray, np.ndarray]:
        return self._run(patches), self._run(context_patches)
