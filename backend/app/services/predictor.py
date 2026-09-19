"""
Prediction service.

The frontend and API routes only ever talk to BasePredictor. Swapping
DummyPredictor for the real model requires no changes anywhere else.
"""

from abc import ABC, abstractmethod
from pathlib import Path
import math

import numpy as np
from PIL import Image

from app.services.analysis import analyze_prediction_tiles
from app.services.qc import build_qc_report, decode_image, tissue_tile_mask as qc_tissue_tile_mask


REFERENCE_SCOPE = "HER2-positive breast tissue reference cohort"


class PredictionInputError(ValueError):
    pass


class BasePredictor(ABC):
    """Contract that every predictor must satisfy."""

    @abstractmethod
    def load(self) -> None:
        """Called once at application startup."""
        ...

    @abstractmethod
    def predict(self, image_bytes: bytes, sample_metadata: dict | None = None) -> dict:
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
    mode = "demo"
    model_version = "dummy-v1"
    reference_scope = REFERENCE_SCOPE
    panel_size = len(GENES)

    def __init__(self, grid_size: int = 20):
        self.grid_size = grid_size
        self._loaded = False
        self._rng = np.random.default_rng(seed=42)

    def load(self) -> None:
        self._loaded = True

    @property
    def is_loaded(self) -> bool:
        return self._loaded

    def predict(self, image_bytes: bytes, sample_metadata: dict | None = None) -> dict:
        if not self._loaded:
            raise RuntimeError("Predictor not loaded")

        image, image_format = decode_image(image_bytes)
        qc = build_qc_report(image)
        metadata = sample_metadata or {}
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

        gene_summary = [
            {
                "gene_name": gene,
                "mean_expression": means[gene],
                "variance_expression": float(np.var([s["expression"][gene] for s in spots])),
            }
            for gene in self.GENES
        ]
        warnings = list(qc["warnings"])
        warnings.append("Demo mode returns synthetic values and does not run the real model")
        result = {
            "spots": spots,
            "prediction_tiles": spots,
            "top_genes": top_genes,
            "model_version": self.model_version,
            "model_metadata": {
                "mode": self.mode,
                "model_version": self.model_version,
                "reference_scope": self.reference_scope,
                "panel_size": self.panel_size,
                "output_type": "prediction_tiles",
            },
            "image_metadata": {
                "format": image_format,
                "width_pixels": image.width,
                "height_pixels": image.height,
                "pixel_count": image.width * image.height,
                "microns_per_pixel": metadata.get("microns_per_pixel"),
                "target_microns_per_pixel": None,
                "resampled_width_pixels": image.width,
                "resampled_height_pixels": image.height,
            },
            "coordinate_metadata": {
                "x_y_units": "demo_grid_units",
                "bounds_units": "original_image_pixels",
                "origin": "top_left",
                "x_y_semantics": "synthetic_demo_grid_position",
            },
            "qc": qc,
            "applicability": {
                "reference_scope": self.reference_scope,
                "her2_positive_breast_tissue_confirmed": bool(metadata.get("her2_positive_breast_tissue")),
                "he_stain_confirmed": metadata.get("stain") == "H&E",
                "within_reference_scope": False,
            },
            "warnings": warnings,
            "all_gene_summary": {
                "authoritative": True,
                "statistics": ["mean", "variance"],
                "genes": gene_summary,
            },
        }
        result.update(analyze_prediction_tiles(spots))
        return result


def tissue_tile_mask(image: Image.Image, patch: int = 224, stride: int = 224,
                     sat_thresh: float = 0.10, min_frac: float = 0.10,
                     downsample: int = 8) -> dict[tuple[int, int], bool]:
    """
    Decide which grid tiles contain tissue.

    Returns a dict keyed by (ix, iy) -> bool, using the SAME (ix, iy) indexing
    as _tile(), so coords stay consistent with the heatmap.
    """
    w, h = image.size
    # .convert("RGB") first: PIL will not go straight from RGBA or palette mode
    # to HSV, and PNG uploads arrive as both.
    small = image.convert("RGB").convert("HSV").resize(
        (max(1, w // downsample), max(1, h // downsample)), Image.BILINEAR)
    sat = np.asarray(small)[:, :, 1].astype(np.float32) / 255.0
    tissue = sat > sat_thresh

    keep = {}
    for iy, y in enumerate(range(0, h - patch + 1, stride)):
        for ix, x in enumerate(range(0, w - patch + 1, stride)):
            y0, y1 = y // downsample, (y + patch) // downsample
            x0, x1 = x // downsample, (x + patch) // downsample
            block = tissue[y0:y1, x0:x1]
            keep[(ix, iy)] = bool(block.size and block.mean() >= min_frac)
    return keep


class MclSTExpPredictor(BasePredictor):
    """
    Backed by the mclSTExp checkpoint (best_0.pt) trained on the HER2+
    dataset. Architecture: app.services.mclstexp.model.mclSTExp_Attention.

    The network does not output gene expression. A forward pass produces a
    256-dim embedding; expression comes from a separate retrieval step that
    weighted-averages the real lab-measured expression of the TOP_K most
    similar reference spots. Hence both the checkpoint and the reference
    database in data_root are required.
    """

    MODEL_VERSION = "mclstexp-her2st-best_0"
    mode = "real"
    model_version = MODEL_VERSION
    reference_scope = REFERENCE_SCOPE
    panel_size = 785
    TARGET_MICRONS_PER_PIXEL = 100.0 / 224.0
    MAX_RESAMPLED_PIXELS = 100_000_000

    TOP_K = 200      # fixed by the training config — not a tuning knob
    PATCH = 224      # the model was trained on 224x224 crops
    STRIDE = 224     # non-overlapping tiles; assumes HER2ST-like magnification
    BATCH_SIZE = 16

    # Ceiling on tissue tiles the synchronous request path will accept. Sized
    # for the deployment host, not the model: one shared vCPU at 50-150ms per
    # patch puts anything larger past the platform request timeout.
    MAX_PATCHES = 470

    N_GENES = 785
    N_SPOTS = 11548

    # spot_embeddings_1..32 map to these sections, in this order. The ordering
    # is load-bearing: the expression matrices must line up with the embeddings.
    SECTIONS = [
        "A2", "A3", "A4", "A5", "A6", "B1", "B2", "B3", "B4", "B5", "B6",
        "C1", "C2", "C3", "C4", "C5", "C6", "D1", "D2", "D3", "D4", "D5",
        "D6", "E1", "E2", "E3", "F1", "F2", "F3", "G1", "G2", "G3",
    ]

    def __init__(self, checkpoint_path: str, data_root: str):
        self.checkpoint_path = checkpoint_path
        self.data_root = data_root
        self.device = "cpu"
        self._model = None
        self._torch = None
        self.spot_key = None
        self.spot_key_n = None
        self.expr_key = None
        self.genes = None

    def load(self) -> None:
        """Called once at application startup. Never per request."""
        db = Path(self.data_root)
        missing = missing_required_artifacts(self.data_root, self.checkpoint_path)
        if missing:
            raise RuntimeError(f"Required model artifacts are missing or empty: {', '.join(missing)}")
        import torch
        from app.services.mclstexp.model import mclSTExp_Attention

        self._torch = torch

        # 1. Model
        model = mclSTExp_Attention(
            encoder_name='densenet121', spot_dim=785, temperature=1.0,
            image_dim=1024, projection_dim=256,
            heads_num=8, heads_dim=64, head_layers=2, dropout=0.)
        sd = self._torch.load(self.checkpoint_path, map_location='cpu')
        sd = {k.replace('module.', '').replace('well', 'spot'): v for k, v in sd.items()}
        model.load_state_dict(sd)
        model.eval()
        model.to(self.device)
        self._model = model

        # 2. Reference database — 32 sections of spot embeddings paired with
        #    the real expression measured at those same spots.
        spot_embs, exprs = [], []
        for i, section in enumerate(self.SECTIONS, start=1):
            spot_embs.append(np.load(db / f"spot_embeddings_{i}.npy"))   # (256, n_spots)
            exprs.append(np.load(
                db / "preprocessed_expression_matrices" / "her2st" /
                section / "preprocessed_matrix.npy"))                    # (785, n_spots)

        self.spot_key = np.concatenate(spot_embs, axis=1).T.astype(np.float32)   # (11548, 256)
        self.expr_key = np.concatenate(exprs, axis=1).T.astype(np.float32)       # (11548, 785)

        if self.spot_key.shape[0] != self.expr_key.shape[0]:
            raise RuntimeError(
                f"Embedding/expression misalignment: {self.spot_key.shape[0]} "
                f"spot embeddings vs {self.expr_key.shape[0]} expression rows")
        if self.spot_key.shape[0] != self.N_SPOTS:
            raise RuntimeError(
                f"Expected {self.N_SPOTS} reference spots, got "
                f"{self.spot_key.shape[0]} — check the section order in SECTIONS")

        # Pre-normalise once, so each request only normalises its own queries.
        self.spot_key_n = self.spot_key / np.linalg.norm(
            self.spot_key, axis=1, keepdims=True)

        # 3. Gene names, in the order the expression columns appear
        self.genes = [str(g) for g in
                      np.load(db / "her_hvg_cut_1000.npy", allow_pickle=True)]
        if len(self.genes) != self.N_GENES:
            raise RuntimeError(
                f"Expected {self.N_GENES} gene names, got {len(self.genes)}")

    @property
    def is_loaded(self) -> bool:
        return self._model is not None and self.spot_key is not None

    # ------------------------------------------------------------------

    def _tile(self, image: Image.Image, stride: int | None = None):
        """Grid-tile the slide. Returns (patches, coords)."""
        stride = self.STRIDE if stride is None else stride
        w, h = image.size
        patches, coords = [], []
        for iy, y in enumerate(range(0, h - self.PATCH + 1, stride)):
            for ix, x in enumerate(range(0, w - self.PATCH + 1, stride)):
                patches.append(image.crop((x, y, x + self.PATCH, y + self.PATCH)))
                coords.append((ix, iy))
        return patches, coords

    def _encode(self, patches, batch_size: int | None = None):
        """Patches -> 256-dim embeddings. RAW 0-1 TENSORS, NO NORMALISATION.

        The checkpoint was trained with ToTensor() only — dataset.py applies no
        Normalize in either train or eval mode. Adding ImageNet normalisation
        here degrades every prediction without raising anything.

        Plain loop, no DataLoader: forked workers inherit lazily-opened PIL file
        descriptors and concurrent reads silently corrupt the crops.
        """
        batch_size = self.BATCH_SIZE if batch_size is None else batch_size
        out = []
        with self._torch.no_grad():
            for i in range(0, len(patches), batch_size):
                chunk = patches[i:i + batch_size]
                # ToTensor() equivalent only. Do NOT add transforms.Normalize.
                batch = self._torch.stack([
                    self._torch.from_numpy(np.array(p.convert("RGB"), dtype=np.float32) / 255.0)
                         .permute(2, 0, 1)
                    for p in chunk
                ]).to(self.device)

                # Sub-modules called directly. mclSTExp_Attention.forward() has a
                # hardcoded .cuda() for the contrastive-loss label and is only
                # used in training; it would crash on a CPU-only host.
                feats = self._model.image_encoder(batch)        # DenseNet -> (B, 1024)
                embs = self._model.image_projection(feats)      # -> (B, 256)
                out.append(embs.cpu().numpy())
        return np.concatenate(out, axis=0)

    def _retrieve(self, query: np.ndarray) -> tuple[np.ndarray, list[dict]]:
        """Query embeddings -> predicted expression. No learned parameters here."""
        qn = query / np.linalg.norm(query, axis=1, keepdims=True)
        sim = qn @ self.spot_key_n.T                                     # (n_query, 11548)
        idx = np.argpartition(-sim, self.TOP_K, axis=1)[:, :self.TOP_K]  # top-200

        pred = np.zeros((query.shape[0], self.expr_key.shape[1]), dtype=np.float32)
        support = []
        for i in range(query.shape[0]):
            nb = idx[i]
            # inverse squared L1 distance, on the UNNORMALISED embeddings
            d = np.linalg.norm(self.spot_key[nb] - query[i], axis=1, ord=1)
            w = np.reciprocal(np.maximum(d, 1e-12) ** 2)   # clamp guards 1/0 -> nan
            w = w / w.sum()
            pred[i] = np.average(self.expr_key[nb], axis=0, weights=w)
            selected_similarity = sim[i, nb]
            expression_delta = self.expr_key[nb] - pred[i]
            per_gene_dispersion = np.average(expression_delta ** 2, axis=0, weights=w)
            support.append({
                "max_selected_cosine_similarity": float(np.max(selected_similarity)),
                "mean_selected_cosine_similarity": float(np.mean(selected_similarity)),
                "effective_neighbor_count": float(1.0 / np.sum(w ** 2)),
                "aggregate_neighbor_expression_dispersion": float(np.mean(per_gene_dispersion)),
            })
        return pred, support

    # ------------------------------------------------------------------

    def predict(self, image_bytes: bytes, sample_metadata: dict | None = None) -> dict:
        if not self.is_loaded:
            raise RuntimeError("Predictor not loaded")

        metadata = sample_metadata or {}
        microns_per_pixel = metadata.get("microns_per_pixel")
        if not isinstance(microns_per_pixel, (int, float)) or not math.isfinite(microns_per_pixel) or microns_per_pixel <= 0:
            raise PredictionInputError("A valid microns-per-pixel value is required for real inference")
        image, image_format = decode_image(image_bytes)
        scale = microns_per_pixel / self.TARGET_MICRONS_PER_PIXEL
        resampled_width = max(1, round(image.width * scale))
        resampled_height = max(1, round(image.height * scale))
        if resampled_width * resampled_height > self.MAX_RESAMPLED_PIXELS:
            raise PredictionInputError("The image exceeds the supported pixel count after target-scale resampling")
        resampled = image.resize((resampled_width, resampled_height), Image.Resampling.LANCZOS)
        qc = build_qc_report(image, tile_image=resampled, patch=self.PATCH, stride=self.STRIDE)

        patches, coords = self._tile(resampled)
        if not patches:
            w, h = image.size
            raise PredictionInputError(
                f"Image is {w}x{h}px and is too small to produce a prediction tile at the target scale")

        # Background tiles are dropped before encoding: each one costs a
        # forward pass, and the expression retrieved for a patch of glass
        # would otherwise pull the top_genes means toward whatever the
        # reference set happens to say about off-tissue spots.
        keep = qc_tissue_tile_mask(resampled, patch=self.PATCH, stride=self.STRIDE)
        kept = [i for i, c in enumerate(coords) if keep[c]]
        if not kept:
            raise PredictionInputError(
                f"No tissue was detected in any of the {len(patches)} prediction tiles")

        # Checked against tissue tiles, not raw grid tiles: the mask is what
        # decides the real cost of the request. Refused outright rather than
        # truncated — a partial slide would return a prediction that silently
        # covers only part of the tissue.
        if len(kept) > self.MAX_PATCHES:
            raise PredictionInputError(
                f"The image requires {len(kept)} tissue prediction tiles, exceeding the {self.MAX_PATCHES} tile limit")

        patches = [patches[i] for i in kept]
        coords = [coords[i] for i in kept]

        query = self._encode(patches)                    # tissue tiles only
        pred, support = self._retrieve(query)            # (n_tissue, 785)

        scale_x = resampled_width / image.width
        scale_y = resampled_height / image.height
        spots = []
        for i, (cx, cy) in enumerate(coords):
            left = cx * self.STRIDE / scale_x
            top = cy * self.STRIDE / scale_y
            right = min(image.width, (cx * self.STRIDE + self.PATCH) / scale_x)
            bottom = min(image.height, (cy * self.STRIDE + self.PATCH) / scale_y)
            spots.append({
                "spot_index": i,
                "tile_index": i,
                "x": float((left + right) / 2.0),
                "y": float((top + bottom) / 2.0),
                "bounds": {
                    "left": float(left),
                    "top": float(top),
                    "right": float(right),
                    "bottom": float(bottom),
                },
                "expression": {g: float(v) for g, v in zip(self.genes, pred[i])},
                "retrieval_support": support[i],
            })

        mean_expr = pred.mean(axis=0)                    # tissue tiles only
        variance_expr = pred.var(axis=0)
        order = np.argsort(-mean_expr)
        top_genes = [
            {"gene_name": self.genes[g],
             "mean_expression": float(mean_expr[g]),
             "rank": r + 1}
            for r, g in enumerate(order[:50])
        ]
        gene_summary = [
            {
                "gene_name": gene,
                "mean_expression": float(mean_expr[index]),
                "variance_expression": float(variance_expr[index]),
            }
            for index, gene in enumerate(self.genes)
        ]

        result = {
            "spots": spots,
            "prediction_tiles": spots,
            "top_genes": top_genes,
            "model_version": self.MODEL_VERSION,
            "model_metadata": {
                "mode": self.mode,
                "model_version": self.MODEL_VERSION,
                "reference_scope": self.reference_scope,
                "panel_size": len(self.genes),
                "output_type": "prediction_tiles",
                "retrieval_support_label": "retrieval_support",
                "retrieval_neighbor_selection": "top_200_cosine_similarity",
                "retrieval_weighting": "inverse_squared_l1_distance",
            },
            "image_metadata": {
                "format": image_format,
                "width_pixels": image.width,
                "height_pixels": image.height,
                "pixel_count": image.width * image.height,
                "microns_per_pixel": float(microns_per_pixel),
                "target_microns_per_pixel": self.TARGET_MICRONS_PER_PIXEL,
                "resampled_width_pixels": resampled_width,
                "resampled_height_pixels": resampled_height,
            },
            "coordinate_metadata": {
                "x_y_units": "original_image_pixels",
                "bounds_units": "original_image_pixels",
                "origin": "top_left",
                "x_y_semantics": "prediction_tile_center",
            },
            "qc": qc,
            "applicability": {
                "reference_scope": self.reference_scope,
                "her2_positive_breast_tissue_confirmed": metadata.get("her2_positive_breast_tissue") is True,
                "he_stain_confirmed": metadata.get("stain") == "H&E",
                "within_reference_scope": metadata.get("her2_positive_breast_tissue") is True and metadata.get("stain") == "H&E",
            },
            "warnings": list(qc["warnings"]),
            "all_gene_summary": {
                "authoritative": True,
                "statistics": ["mean", "variance"],
                "genes": gene_summary,
            },
        }
        result.update(analyze_prediction_tiles(spots))
        return result


def required_artifact_paths(data_root: str | Path, checkpoint_path: str | Path) -> list[Path]:
    root = Path(data_root)
    paths = [Path(checkpoint_path), root / "her_hvg_cut_1000.npy"]
    paths.extend(root / f"spot_embeddings_{index}.npy" for index in range(1, 33))
    paths.extend(
        root / "preprocessed_expression_matrices" / "her2st" / section / "preprocessed_matrix.npy"
        for section in MclSTExpPredictor.SECTIONS
    )
    return paths


def missing_required_artifacts(data_root: str | Path, checkpoint_path: str | Path) -> list[str]:
    root = Path(data_root)
    missing = []
    for path in required_artifact_paths(root, checkpoint_path):
        if not path.is_file() or path.stat().st_size == 0:
            try:
                missing.append(str(path.relative_to(root)))
            except ValueError:
                missing.append(str(path))
    return missing


def get_predictor(settings) -> BasePredictor:
    if settings.mode == "demo":
        return DummyPredictor()
    if settings.mode == "real":
        return MclSTExpPredictor(settings.model_checkpoint_path, settings.model_data_root)
    raise ValueError("Predictor mode must be either 'real' or 'demo'")
