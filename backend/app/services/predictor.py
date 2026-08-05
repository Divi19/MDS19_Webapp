"""
Prediction service.

The frontend and API routes only ever talk to BasePredictor. Swapping
DummyPredictor for the real model requires no changes anywhere else.
"""

from abc import ABC, abstractmethod
import numpy as np


class BasePredictor(ABC):
    """Contract that every predictor must satisfy."""

    @abstractmethod
    def load(self) -> None:
        """Called once at application startup."""
        ...

    @abstractmethod
    def predict(self, image_bytes: bytes) -> dict:
        """
        Returns:
            {
              "spots": [{"spot_index": int, "x": float, "y": float,
                         "expression": {gene: value}}],
              "top_genes": [{"gene_name": str, "mean_expression": float,
                             "rank": int}],
              "model_version": str,
            }
        """
        ...

    @property
    @abstractmethod
    def is_loaded(self) -> bool:
        ...


class DummyPredictor(BasePredictor):
    """
    Generates plausibly-shaped fake output so the frontend can be built
    and tested before the real model exists.

    Output shape matches the real model exactly: a hex-ish grid of spots,
    each with expression values across a small gene panel.
    """

    GENES = [
        "ERBB2", "GRB7", "STARD3", "MIEN1", "PGAP3",
        "ESR1", "PGR", "MKI67", "CD8A", "COL1A1",
        "KRT5", "KRT14", "ACTA2", "VWF", "PTPRC",
    ]

    def __init__(self, grid_size: int = 20):
        self.grid_size = grid_size
        self._loaded = False
        self._rng = np.random.default_rng(seed=42)

    def load(self) -> None:
        self._loaded = True

    @property
    def is_loaded(self) -> bool:
        return self._loaded

    def predict(self, image_bytes: bytes) -> dict:
        if not self._loaded:
            raise RuntimeError("Predictor not loaded")

        spots = []
        idx = 0
        for row in range(self.grid_size):
            for col in range(self.grid_size):
                # Offset alternate rows to mimic the ST array layout
                x = col + (0.5 if row % 2 else 0.0)
                y = row * 0.866

                # Smooth spatial gradient plus noise, so the heatmap
                # looks like tissue rather than static
                base = np.sin(x / 4) * np.cos(y / 4)
                expression = {
                    gene: float(
                        max(0.0, base * (1 + i * 0.1)
                            + self._rng.normal(0, 0.3) + 1.5)
                    )
                    for i, gene in enumerate(self.GENES)
                }

                spots.append({
                    "spot_index": idx,
                    "x": float(x),
                    "y": float(y),
                    "expression": expression,
                })
                idx += 1

        means = {
            gene: float(np.mean([s["expression"][gene] for s in spots]))
            for gene in self.GENES
        }
        ranked = sorted(means.items(), key=lambda kv: kv[1], reverse=True)
        top_genes = [
            {"gene_name": g, "mean_expression": v, "rank": i + 1}
            for i, (g, v) in enumerate(ranked)
        ]

        return {
            "spots": spots,
            "top_genes": top_genes,
            "model_version": "dummy-v1",
        }


# ---------------------------------------------------------------------------
# Real model — implement when a checkpoint is available.
#
# class MclSTExpPredictor(BasePredictor):
#     def __init__(self, checkpoint_path: str, data_root: str):
#         ...
#     def load(self):
#         # Load checkpoint ONCE here, never per request.
#         # Also load the retrieval database (spot embeddings + expression).
#         ...
#     def predict(self, image_bytes: bytes) -> dict:
#         # 1. Tile the image into patches
#         # 2. Encode patches -> image embeddings
#         # 3. Retrieve top-200 nearest spot embeddings
#         # 4. Weighted-average their expression
#         # 5. Return in the same shape as DummyPredictor
#         ...
# ---------------------------------------------------------------------------


def get_predictor(settings) -> BasePredictor:
    if settings.use_dummy_predictor:
        return DummyPredictor()
    raise NotImplementedError(
        "Real predictor not implemented yet. "
        "Set USE_DUMMY_PREDICTOR=true in .env"
    )