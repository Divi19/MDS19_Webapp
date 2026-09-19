"""
Prediction service.

The frontend and API routes only ever talk to BasePredictor. Swapping
DummyPredictor for the real model requires no changes anywhere else.
"""

from abc import ABC, abstractmethod
from pathlib import Path
import io

import numpy as np
import torch
from PIL import Image, ImageOps

from app.services.mclstexp.model import mclSTExp_Attention
from app.services.gradcam import GradCAM, overlay_heatmap, encode_png, tissue_pixel_mask


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

    def explain(self, image_bytes: bytes, spot_index: int) -> bytes:
        """
        Grad-CAM overlay (PNG bytes) for one tissue patch. Optional — only
        MclSTExpPredictor implements this; predictors without a real image
        encoder have nothing for Grad-CAM to visualise.
        """
        raise NotImplementedError(
            f"{type(self).__name__} does not support Grad-CAM explanations")


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


def tissue_tile_mask(image: Image.Image, patch: int = 224, stride: int = 224,
                     sat_thresh: float = 0.18, min_frac: float = 0.25,
                     downsample: int = 8) -> dict[tuple[int, int], bool]:
    """
    Decide which grid tiles contain tissue.

    Returns a dict keyed by (ix, iy) -> bool, using the SAME (ix, iy) indexing
    as _tile(), so coords stay consistent with the heatmap.

    sat_thresh/min_frac were raised from 0.10/0.10 (web app deployment,
    2026-09) after real uploads showed a wedge of false-positive tiles
    fading out beyond the true tissue edge — faint peripheral staining and
    scan artifacts were clearing the old 10% saturation bar over just 10%
    of a tile's pixels. These values are a reasoned first pass, not
    validated against a held-out slide set; if a thin/faint real tissue
    edge starts getting excluded, loosen min_frac before sat_thresh, since
    min_frac controls how much of a tile must qualify, sat_thresh how
    strongly.
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

    TOP_K = 200      # fixed by the training config — not a tuning knob
    PATCH = 224      # the model was trained on 224x224 crops
    STRIDE = 224     # non-overlapping tiles; assumes HER2ST-like magnification
    BATCH_SIZE = 16

    # Ceiling on tissue tiles the synchronous request path will accept. Sized
    # for the deployment host, not the model: one shared vCPU at 50-150ms per
    # patch puts anything larger past the platform request timeout.
    MAX_PATCHES = 600

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
        self.spot_key = None
        self.spot_key_n = None
        self.expr_key = None
        self.genes = None
        self._gradcam = None

    def load(self) -> None:
        """Called once at application startup. Never per request."""
        db = Path(self.data_root)

        # 1. Model
        model = mclSTExp_Attention(
            encoder_name='densenet121', spot_dim=785, temperature=1.0,
            image_dim=1024, projection_dim=256,
            heads_num=8, heads_dim=64, head_layers=2, dropout=0.)
        sd = torch.load(self.checkpoint_path, map_location='cpu')
        sd = {k.replace('module.', '').replace('well', 'spot'): v for k, v in sd.items()}
        model.load_state_dict(sd)
        model.eval()
        model.to(self.device)
        self._model = model

        # Grad-CAM hooks the last DenseNet dense block (7x7 spatial resolution
        # at 224px input) — same target layer used in the exploratory notebook.
        self._gradcam = GradCAM(model, model.image_encoder.model[0].denseblock4)

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
        with torch.no_grad():
            for i in range(0, len(patches), batch_size):
                chunk = patches[i:i + batch_size]
                # ToTensor() equivalent only. Do NOT add transforms.Normalize.
                batch = torch.stack([
                    torch.from_numpy(np.array(p.convert("RGB"), dtype=np.float32) / 255.0)
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

    def _retrieve(self, query: np.ndarray) -> np.ndarray:
        """Query embeddings -> predicted expression. No learned parameters here."""
        qn = query / np.linalg.norm(query, axis=1, keepdims=True)
        sim = qn @ self.spot_key_n.T                                     # (n_query, 11548)
        idx = np.argpartition(-sim, self.TOP_K, axis=1)[:, :self.TOP_K]  # top-200

        pred = np.zeros((query.shape[0], self.expr_key.shape[1]), dtype=np.float32)
        for i in range(query.shape[0]):
            nb = idx[i]
            # inverse squared L1 distance, on the UNNORMALISED embeddings
            d = np.linalg.norm(self.spot_key[nb] - query[i], axis=1, ord=1)
            w = np.reciprocal(np.maximum(d, 1e-12) ** 2)   # clamp guards 1/0 -> nan
            w = w / w.sum()
            pred[i] = np.average(self.expr_key[nb], axis=0, weights=w)
        return pred

    # ------------------------------------------------------------------

    def predict(self, image_bytes: bytes) -> dict:
        if not self.is_loaded:
            raise RuntimeError("Predictor not loaded")

        image = Image.open(io.BytesIO(image_bytes))
        image.load()
        # Browsers auto-rotate a displayed <img> per its EXIF orientation tag;
        # PIL does not. Without this, a rotated JPEG (phone/scanner exports
        # commonly carry this tag) gets tiled in its raw, unrotated pixel
        # grid while the frontend shows and overlays on the rotated version —
        # spot positions then land nowhere near the tissue they were
        # predicted from. Bakes the rotation into the pixels so both sides
        # agree on the same orientation.
        image = ImageOps.exif_transpose(image)

        patches, coords = self._tile(image)
        if not patches:
            w, h = image.size
            raise ValueError(
                f"Image is {w}x{h}px — too small to tile into "
                f"{self.PATCH}x{self.PATCH} patches")

        # Background tiles are dropped before encoding: each one costs a
        # forward pass, and the expression retrieved for a patch of glass
        # would otherwise pull the top_genes means toward whatever the
        # reference set happens to say about off-tissue spots.
        keep = tissue_tile_mask(image, patch=self.PATCH, stride=self.STRIDE)
        kept = [i for i, c in enumerate(coords) if keep[c]]
        if not kept:
            raise ValueError(
                f"No tissue detected in any of the {len(patches)} tiles — "
                f"the slide may be blank, or the saturation threshold too high")

        # Checked against tissue tiles, not raw grid tiles: the mask is what
        # decides the real cost of the request. Refused outright rather than
        # truncated — a partial slide would return a prediction that silently
        # covers only part of the tissue.
        if len(kept) > self.MAX_PATCHES:
            raise ValueError(
                f"Slide requires {len(kept)} tissue patches, exceeding the "
                f"{self.MAX_PATCHES} limit for synchronous processing. "
                f"Full whole-slide support is planned post-deadline.")

        patches = [patches[i] for i in kept]
        coords = [coords[i] for i in kept]

        query = self._encode(patches)                    # tissue tiles only
        pred = self._retrieve(query)                     # (n_tissue, 785)

        spots = [
            {
                "spot_index": i,
                "x": float(cx),
                "y": float(cy),
                "expression": {g: float(v) for g, v in zip(self.genes, pred[i])},
            }
            for i, (cx, cy) in enumerate(coords)
        ]

        mean_expr = pred.mean(axis=0)                    # tissue tiles only
        order = np.argsort(-mean_expr)
        top_genes = [
            {"gene_name": self.genes[g],
             "mean_expression": float(mean_expr[g]),
             "rank": r + 1}
            for r, g in enumerate(order[:50])
        ]

        return {
            "spots": spots,
            "top_genes": top_genes,
            "model_version": self.MODEL_VERSION,
        }

    # ------------------------------------------------------------------

    def explain(self, image_bytes: bytes, spot_index: int) -> bytes:
        """
        Grad-CAM overlay (PNG bytes) for one tissue patch.

        spot_index is keyed the same way predict() keys its "spots" list:
        position within the tissue-only tile list, after background tiles
        are dropped. Re-tiles and re-masks from scratch rather than caching
        the previous request's layout, since tiling is a pure function of
        the image and this endpoint is called standalone.
        """
        if not self.is_loaded:
            raise RuntimeError("Predictor not loaded")

        image = Image.open(io.BytesIO(image_bytes))
        image.load()

        patches, coords = self._tile(image)
        if not patches:
            w, h = image.size
            raise ValueError(
                f"Image is {w}x{h}px — too small to tile into "
                f"{self.PATCH}x{self.PATCH} patches")

        keep = tissue_tile_mask(image, patch=self.PATCH, stride=self.STRIDE)
        kept = [i for i, c in enumerate(coords) if keep[c]]
        if not (0 <= spot_index < len(kept)):
            raise ValueError(
                f"spot_index {spot_index} out of range — this image has "
                f"{len(kept)} tissue tiles (0..{len(kept) - 1})")

        patch = patches[kept[spot_index]]
        patch_tensor = torch.from_numpy(
            np.array(patch.convert("RGB"), dtype=np.float32) / 255.0
        ).permute(2, 0, 1).unsqueeze(0).to(self.device)

        # Nearest-neighbour step in embedding space (spot_key), not expression
        # space (expr_key) — Grad-CAM explains what the encoder is looking at,
        # not the retrieved genes. Uses the SINGLE nearest neighbour, not the
        # mean of TOP_K like _retrieve() does: averaging 200 embeddings washes
        # the target into something generic, which flattens the gradient
        # signal and produces heatmaps that barely respond to image content.
        with torch.no_grad():
            query = self._model.image_projection(
                self._model.image_encoder(patch_tensor)).cpu().numpy()
        qn = query / np.linalg.norm(query, axis=1, keepdims=True)
        sim = qn @ self.spot_key_n.T
        nn_idx = int(np.argmax(sim[0]))
        target = torch.from_numpy(
            self.spot_key[nn_idx:nn_idx + 1]
        ).float().to(self.device)

        heatmap = self._gradcam.generate(patch_tensor, target)
        mask = tissue_pixel_mask(patch)
        overlay = overlay_heatmap(patch, heatmap, tissue_mask=mask)
        return encode_png(overlay)


def get_predictor(settings) -> BasePredictor:
    if settings.use_dummy_predictor:
        return DummyPredictor()
    return MclSTExpPredictor(settings.model_checkpoint_path, settings.model_data_root)
