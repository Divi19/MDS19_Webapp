"""
Prediction service.

The frontend and API routes only ever talk to BasePredictor. Swapping
DummyPredictor for the real model requires no changes anywhere else.
"""

from abc import ABC, abstractmethod
from pathlib import Path
import hashlib
import io
import logging

import numpy as np
import torch
from PIL import Image, ImageOps

from app.services.mclstexp.model import mclSTExp_Attention, ProjectionHead
from app.services.gradcam import GradCAM, TileResult, ViTGradCAM, overlay_heatmap, encode_png, tile_result, tissue_pixel_mask
from app.services.encoders import (
    build_encoder, H0MINI_COMBINED_DIM, H0MINI_CONTEXT_MULTIPLIER,
)
from app.services.tissue import H0MiniFeatureExtractor, attach_tissue, load_tissue_classifier

logger = logging.getLogger(__name__)


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

    # Version of the tissue classifier attached to predictions, or None when
    # this predictor does not run one. Reported by /api/health.
    tissue_model_version: str | None = None

    def explain(self, image_bytes: bytes, spot_index: int, gene: str | None = None) -> bytes:
        """
        Grad-CAM overlay (PNG bytes) for one tissue patch. Optional — only
        MclSTExpPredictor implements this; predictors without a real image
        encoder have nothing for Grad-CAM to visualise.
        """
        raise NotImplementedError(
            f"{type(self).__name__} does not support Grad-CAM explanations")

    def explain_batch(self, image_bytes: bytes, spot_indices: list[int],
                       gene: str | None = None) -> list[TileResult]:
        """Batched form of explain() — see MclSTExpPredictor.explain_batch()."""
        raise NotImplementedError(
            f"{type(self).__name__} does not support batched Grad-CAM explanations")


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


def smooth(pred: np.ndarray, coords: np.ndarray,
           alpha: float = 0.6, radius: float = 1.5) -> np.ndarray:
    """
    Spatial smoothing over the tile grid: blend each spot's prediction with the
    mean of its immediate neighbours.

    Neighbouring spots in real tissue are strongly correlated, while the
    retrieval step's error is largely independent between them, so averaging
    over a small neighbourhood cancels noise faster than it blurs signal.
    Measured at +0.0125 HVG PCC on the tau020 base (32-fold LOO). It has NOT
    been measured on the DenseNet baseline this backend runs — expected to
    help for the same reason, but no quotable number until that eval is done.

    Transductive, not leakage: it uses the uploaded slide's own tile
    coordinates and no ground truth.

    `coords` MUST be tile grid indices (integers, adjacent tiles 1 apart), not
    pixels. With radius 1.5 that is 8-connectivity: 8 neighbours for an
    interior tile, 5 along an edge, 3 at a corner. Pixel coords silently yield
    zero neighbours and the function becomes a no-op, so predict() logs the
    mean neighbour count.
    """
    d = np.linalg.norm(coords[:, None, :] - coords[None, :, :], axis=-1)
    W = ((d > 0) & (d <= radius)).astype(np.float32)
    s = W.sum(1, keepdims=True); s[s == 0] = 1.0
    nbr = (W / s) @ pred
    # Isolated tiles keep their raw prediction rather than blending to self.
    return np.where((W.sum(1) > 0)[:, None], (1 - alpha) * pred + alpha * nbr, pred)


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

    # Spatial smoothing (Path A). alpha is fixed for the deployment
    # rather than selected per slide.
    SMOOTHING_ALPHA = 0.6
    SMOOTHING_RADIUS = 1.5

    TOP_K = 200      # fixed by the training config — not a tuning knob
    PATCH = 224      # the model was trained on 224x224 crops
    STRIDE = 224     # non-overlapping tiles; assumes HER2ST-like magnification
    BATCH_SIZE = 16

    # Ceiling on tissue tiles the synchronous request path will accept. Sized
    # for the deployment host, not the model: one shared vCPU at 50-150ms per
    # patch puts anything larger past the platform request timeout.
    MAX_PATCHES = 600

    # v7 (h0mini) queries a second, wider crop for context — see
    # encoders.H0MINI_CONTEXT_MULTIPLIER. Unused on the densenet121 path.
    CONTEXT_MULTIPLIER = H0MINI_CONTEXT_MULTIPLIER

    N_GENES = 785
    N_SPOTS = 11548

    # spot_embeddings_1..32 map to these sections, in this order. The ordering
    # is load-bearing: the expression matrices must line up with the embeddings.
    SECTIONS = [
        "A2", "A3", "A4", "A5", "A6", "B1", "B2", "B3", "B4", "B5", "B6",
        "C1", "C2", "C3", "C4", "C5", "C6", "D1", "D2", "D3", "D4", "D5",
        "D6", "E1", "E2", "E3", "F1", "F2", "F3", "G1", "G2", "G3",
    ]

    def __init__(self, checkpoint_path: str, data_root: str,
                 enable_smoothing: bool = True,
                 smoothing_alpha: float | None = None,
                 encoder_backend: str = "densenet121",
                 device: str = "cpu",
                 tissue_classifier_enabled: bool = False,
                 tissue_classifier_dir: str = "",
                 hf_token: str = ""):
        self.checkpoint_path = checkpoint_path
        self.data_root = data_root
        self.device = device   # "cuda" on the Modal Grad-CAM service; Render is CPU-only
        self._model = None
        self.spot_key = None
        self.spot_key_n = None
        self.expr_key = None
        self.genes = None
        self._gradcam = None
        self._encoder = None
        self._projection = None

        # Which image encoder produces the query features. The reference bank
        # in data_root MUST have been produced by the same one — a mismatch
        # means matching across two unrelated embedding spaces, which fails
        # silently. Nothing in load() can detect it; that is what
        # scripts/acceptance_test_fold0.py is for.
        if encoder_backend not in ("densenet121", "h0mini"):
            raise ValueError(
                f"encoder_backend must be 'densenet121' or 'h0mini', "
                f"got {encoder_backend!r}")
        self.encoder_backend = encoder_backend
        # h0mini is the v7 dual-crop architecture (native ++ context, 3072-d)
        # per MDS19_Deployment_Brief.md §3 — NOT the older single-crop tau020
        # stage, which is deprecated and must not be deployed.
        self._encoder_feature_dim = (1024 if encoder_backend == "densenet121"
                                     else H0MINI_COMBINED_DIM)

        # Single-slot cache: the whole-slide Grad-CAM mosaic calls explain()
        # once per tissue tile (up to MAX_PATCHES times) for the same
        # upload — re-tiling and re-masking the whole image from scratch on
        # every one of those calls was pure waste, since tiling doesn't
        # depend on spot_index. One slot (not an LRU) because the real usage
        # pattern is "one image, many tiles", not many images at once.
        # (key, patches, kept, image, coords) — image/coords are only kept
        # on the h0mini path, whose Grad-CAM needs each tile's wider context
        # crop cut from the full slide (see _tile_context).
        self._tile_cache: tuple | None = None

        # Env-controlled so smoothing can be switched off on the host without
        # a redeploy if it misbehaves — the same rollback property the
        # checkpoint/data-root pair already has.
        self.enable_smoothing = enable_smoothing
        self.smoothing_alpha = (self.SMOOTHING_ALPHA if smoothing_alpha is None
                                else float(smoothing_alpha))

        # Reported to the API and persisted per prediction, so a stored row
        # says which pipeline produced it. With the densenet encoder and
        # smoothing off, this is exactly the previous string.
        base = (self.MODEL_VERSION if encoder_backend == "densenet121"
                else f"mclstexp-her2st-v7-{encoder_backend}")
        self.model_version = (f"{base}+smooth{self.smoothing_alpha:g}"
                              if self.enable_smoothing else base)

        # Tissue-type classifier (app/services/tissue.py). Off by default so
        # callers that don't opt in (e.g. modal_gradcam_app) are unaffected.
        self.tissue_classifier_enabled = tissue_classifier_enabled
        self.tissue_classifier_dir = tissue_classifier_dir
        self._hf_token = hf_token
        self._tissue = None
        self._tissue_extractor = None

    def load(self) -> None:
        """Called once at application startup. Never per request."""
        db = Path(self.data_root)

        # 1. Model
        if self.encoder_backend == "densenet121":
            self._load_densenet_model()
        else:
            self._load_projection_only_model()

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

        # 4. Tissue classifier — last, and never fatal: the expression model
        #    above is fully loaded whatever happens here.
        self._load_tissue_classifier()

    def _load_tissue_classifier(self) -> None:
        self._tissue = load_tissue_classifier(
            self.tissue_classifier_enabled, self.tissue_classifier_dir)
        if self._tissue is None or self.encoder_backend == "h0mini":
            # h0mini reuses the features the expression model computes.
            return
        # densenet121 has no H0-mini features of its own, so the classifier
        # gets a dedicated frozen H0-mini (gated weights: needs HF_TOKEN).
        try:
            self._tissue_extractor = H0MiniFeatureExtractor(self.device, self._hf_token)
        except Exception:
            logger.exception(
                "H0-mini unavailable for the tissue classifier (gated weights "
                "need an HF_TOKEN with access) — tissue feature disabled")
            self._tissue = None

    @property
    def tissue_model_version(self) -> str | None:
        return self._tissue.version if self._tissue is not None else None

    def _tissue_features(self, image, patches, coords, native_feats, context_feats):
        """(native, wide672) H0-mini features for the kept tissue tiles, in
        predict()'s spot order. Reuses the expression model's own features
        on the h0mini path; never re-encodes them."""
        if self.encoder_backend == "h0mini":
            return native_feats, context_feats
        return self._tissue_extractor.features(patches, self._tile_context(image, coords))

    def _load_densenet_model(self) -> None:
        """
        Baseline path: the whole mclSTExp network, strict=True.

        strict=True is the load-bearing safety check here — it is what refuses
        a checkpoint whose projection head is 1536->256 instead of 1024->256.
        Never relax it to squeeze in a different training stage; the image
        branch would silently become a no-op and the predictions would be
        garbage that still renders correctly in the UI.
        """
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
        self._encoder = build_encoder("densenet121", model, self.device)

    def _load_projection_only_model(self) -> None:
        """
        H0-mini path (v7): load ONLY the image_projection head from the
        checkpoint.

        At inference nothing else in the checkpoint is reachable — spot
        embeddings are precomputed, so the spot encoder and the positional
        tables are never touched, and the DenseNet weights are inert because
        H0-mini produces the features. Filtering keys at load keeps resident
        memory low, which is what makes this fit alongside H0-mini on a small
        instance.

        The checkpoint file on Drive is never modified — this filters on read.

        Grad-CAM uses the last transformer block as its target layer
        (gradcam.ViTGradCAM), on the native crop, scored against the real
        3072-d -> 256-d v7 embedding.
        """
        sd = torch.load(self.checkpoint_path, map_location='cpu')
        sd = {k.replace('module.', '').replace('well', 'spot'): v for k, v in sd.items()}

        prefix = "image_projection."
        head_sd = {k[len(prefix):]: v for k, v in sd.items() if k.startswith(prefix)}
        if not head_sd:
            raise RuntimeError(
                f"No '{prefix}*' keys in {self.checkpoint_path} — this does not "
                f"look like an mclSTExp checkpoint")

        in_dim = head_sd["projection.weight"].shape[1]
        if in_dim != self._encoder_feature_dim:
            # The exact mismatch strict=True would have caught on the full
            # model. Checked explicitly because this path cannot use it.
            raise RuntimeError(
                f"Checkpoint projection head takes {in_dim}-d input but the "
                f"{self.encoder_backend} encoder produces "
                f"{self._encoder_feature_dim}-d. Wrong checkpoint for this "
                f"encoder — a baseline checkpoint is 1024, v7's dual-crop "
                f"checkpoint is 3072. 1536 means a single-crop checkpoint "
                f"(tau020 or h0mini_contrastive) — deprecated, do not deploy.")

        head = ProjectionHead(embedding_dim=in_dim, projection_dim=256)
        head.load_state_dict(head_sd)       # strict: the head must be complete
        head.eval()
        head.to(self.device)

        self._projection = head
        self._model = head                  # satisfies is_loaded
        self._encoder = build_encoder(self.encoder_backend, None, self.device)
        self._gradcam = ViTGradCAM(self._encoder, head)
        logger.info("loaded projection head only (%d -> 256), encoder=%s",
                    in_dim, self.encoder_backend)

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

    def _tile_context(self, image: Image.Image, coords, stride: int | None = None):
        """
        v7 (h0mini) only: the wider CONTEXT_MULTIPLIER x crop for each tile in
        `coords`, centred on the SAME point as _tile()'s native crop, then
        resized down to PATCH with bicubic (Deployment Brief §3: "672 x 672
        px ... resized to 224 x 224 (bicubic)").

        `coords` must be exactly what _tile() returned for this image and
        stride — this reconstructs each tile's top-left corner as
        (ix*stride, iy*stride), which only matches _tile()'s own grid when
        the two are called with the same stride.

        PIL's crop() pads out-of-bounds regions with black rather than
        raising, so a context box extending past the slide edge — routine for
        edge tiles, since it is CONTEXT_MULTIPLIER x wider than the native
        tile — needs no special-casing here.
        """
        stride = self.STRIDE if stride is None else stride
        context_crop = self.PATCH * self.CONTEXT_MULTIPLIER

        patches = []
        for ix, iy in coords:
            x, y = ix * stride, iy * stride
            cx, cy = x + self.PATCH / 2, y + self.PATCH / 2  # same centre as the native tile
            half = context_crop / 2
            box = tuple(round(v) for v in (cx - half, cy - half, cx + half, cy + half))
            p = image.crop(box)
            if context_crop != self.PATCH:
                p = p.resize((self.PATCH, self.PATCH), Image.BICUBIC)
            patches.append(p)
        return patches

    def _encode(self, patches, context_patches=None, batch_size: int | None = None,
                return_features: bool = False):
        """Patches -> 256-dim embeddings.

        Preprocessing lives in the encoder (app/services/encoders.py), because
        it differs per backend and getting it wrong is silent: the baseline
        takes raw [0,1] tensors with NO normalisation (trained with ToTensor()
        only), H0-mini takes its own normalisation stats — not ImageNet's,
        for either.

        `context_patches`, when given (v7/h0mini only), must be the same
        length as `patches` and in the same order — each pair is the native
        and context crop of the same tile. Each list is encoded separately
        (the encoder itself does not know which is which) and the two
        1536-d feature sets are concatenated, native first, into the 3072-d
        input image_projection expects (Deployment Brief §3). Left None on
        the densenet121 path, which projects the single 1024-d feature as
        before.

        Sub-modules are called directly rather than through forward():
        mclSTExp_Attention.forward() has a hardcoded .cuda() for the
        contrastive-loss label, is training-only, and would crash on a
        CPU-only host.

        Plain loop, no DataLoader: forked workers inherit lazily-opened PIL
        file descriptors and concurrent reads silently corrupt the crops.

        return_features=True additionally returns the raw encoder features
        (native, context) — context is None without context_patches — so the
        tissue classifier can reuse them. The embeddings are identical either
        way.
        """
        batch_size = self.BATCH_SIZE if batch_size is None else batch_size
        project = (self._projection if self._projection is not None
                   else self._model.image_projection)

        def run(plist):
            out = []
            with torch.no_grad():
                for i in range(0, len(plist), batch_size):
                    feats = self._encoder.encode(plist[i:i + batch_size])
                    out.append(feats.cpu().numpy())
            return np.concatenate(out, axis=0)

        feats = run(patches)
        native_feats, context_feats = feats, None
        if context_patches is not None:
            if len(context_patches) != len(patches):
                raise RuntimeError(
                    f"{len(patches)} native patches vs {len(context_patches)} "
                    f"context patches — must be paired 1:1")
            context_feats = run(context_patches)
            feats = np.concatenate([feats, context_feats], axis=1)

        with torch.no_grad():
            embs = project(torch.from_numpy(feats).float().to(self.device))
        if return_features:
            return embs.cpu().numpy(), native_feats, context_feats
        return embs.cpu().numpy()

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

        context_patches = (self._tile_context(image, coords)
                           if self.encoder_backend == "h0mini" else None)
        query, native_feats, context_feats = self._encode(
            patches, context_patches, return_features=True)   # tissue tiles only
        pred = self._retrieve(query)                     # (n_tissue, 785)

        # Tissue-masked set only: `coords` is already filtered, so background
        # tiles are not in the neighbour graph and cannot bleed into edges.
        if self.enable_smoothing:
            grid = np.asarray(coords, dtype=np.float32)  # tile indices, not pixels
            pred = smooth(pred, grid, alpha=self.smoothing_alpha,
                          radius=self.SMOOTHING_RADIUS)

            # Diagnostic for the coords-are-pixels failure mode: ~0 means
            # pixel coords slipped in and smoothing silently did nothing.
            d = np.linalg.norm(grid[:, None, :] - grid[None, :, :], axis=-1)
            n_nbr = ((d > 0) & (d <= self.SMOOTHING_RADIUS)).sum(1)
            logger.info(
                "smoothing: alpha=%s tiles=%d mean_neighbours=%.2f isolated=%d",
                self.smoothing_alpha, len(coords), float(n_nbr.mean()),
                int((n_nbr == 0).sum()))

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

        result = {
            "spots": spots,
            "top_genes": top_genes,
            "model_version": self.model_version,
        }

        # Tissue type, after the expression result is complete. attach_tissue
        # never raises and never touches the fields above: on any failure the
        # tissue fields are null.
        return attach_tissue(
            result, self._tissue,
            lambda: self._tissue_features(image, patches, coords, native_feats, context_feats),
            coords)

    # ------------------------------------------------------------------

    def _get_tiles(self, image_bytes: bytes) -> tuple[list, list]:
        """Tiling/masking for one upload, cached in a single slot (see
        _tile_cache) — explain() and explain_batch() both call this once
        per tissue tile (or batch of tiles) for the same upload, and
        re-tiling from scratch on every one of those calls was pure waste,
        since it doesn't depend on spot_index.

        Returns (patches, kept) — kept is the tissue-tile index list into
        patches, in the same order predict()'s "spots" list uses.
        """
        key = hashlib.sha256(image_bytes).hexdigest()
        if self._tile_cache is not None and self._tile_cache[0] == key:
            return self._tile_cache[1], self._tile_cache[2]
        # explain_batch() needs (image, coords) on top of this on h0mini —
        # it reads them straight from _tile_cache, same key.

        image = Image.open(io.BytesIO(image_bytes))
        image.load()
        # Must match predict()'s orientation handling — otherwise an
        # EXIF-rotated upload tiles into a different grid shape here than
        # the one predict() used, and spot_index no longer points at the
        # tile the frontend thinks it does.
        image = ImageOps.exif_transpose(image)

        patches, coords = self._tile(image)
        if not patches:
            w, h = image.size
            raise ValueError(
                f"Image is {w}x{h}px — too small to tile into "
                f"{self.PATCH}x{self.PATCH} patches")

        keep = tissue_tile_mask(image, patch=self.PATCH, stride=self.STRIDE)
        kept = [i for i, c in enumerate(coords) if keep[c]]
        if not kept:
            raise ValueError(
                f"No tissue detected in any of the {len(patches)} tiles — "
                f"the slide may be blank, or the saturation threshold too high")

        h0 = self.encoder_backend == "h0mini"
        self._tile_cache = (key, patches, kept, image if h0 else None, coords if h0 else None)
        return patches, kept

    def explain(self, image_bytes: bytes, spot_index: int, gene: str | None = None) -> bytes:
        """
        Grad-CAM overlay (PNG bytes) for one tissue patch.

        spot_index is keyed the same way predict() keys its "spots" list:
        position within the tissue-only tile list, after background tiles
        are dropped.

        gene, if given, changes what Grad-CAM explains: instead of "why does
        this patch resemble its single nearest retrieved neighbour" (generic,
        gene-agnostic), it explains "why does this patch resemble tissue
        known to express {gene} highly" — the target embedding becomes the
        one reference spot with the highest REAL measured expression of that
        gene, rather than the reference spot nearest to this patch's own
        embedding.
        """
        if not self.is_loaded:
            raise RuntimeError("Predictor not loaded")
        if self._gradcam is None:
            raise NotImplementedError(
                f"Grad-CAM has no target layer for the {self.encoder_backend} encoder")
        if self.encoder_backend == "h0mini":
            return self.explain_batch(image_bytes, [spot_index], gene)[0].png

        patches, kept = self._get_tiles(image_bytes)

        if not (0 <= spot_index < len(kept)):
            raise ValueError(
                f"spot_index {spot_index} out of range — this image has "
                f"{len(kept)} tissue tiles (0..{len(kept) - 1})")

        patch = patches[kept[spot_index]]
        patch_tensor = torch.from_numpy(
            np.array(patch.convert("RGB"), dtype=np.float32) / 255.0
        ).permute(2, 0, 1).unsqueeze(0).to(self.device)

        if gene is not None:
            if gene not in self.genes:
                raise ValueError(f"Unknown gene {gene!r}")
            gene_idx = self.genes.index(gene)
            # Single reference spot, not an average — averaging even a
            # handful of embeddings washes the target into something
            # generic and flattens the gradient signal (see the
            # single-nearest-neighbour note below, same lesson applied here).
            top_idx = int(np.argmax(self.expr_key[:, gene_idx]))
            target = torch.from_numpy(
                self.spot_key[top_idx:top_idx + 1]
            ).float().to(self.device)
        else:
            # Nearest-neighbour step in embedding space (spot_key), not
            # expression space (expr_key) — Grad-CAM explains what the
            # encoder is looking at, not the retrieved genes. Uses the
            # SINGLE nearest neighbour, not the mean of TOP_K like
            # _retrieve() does: averaging 200 embeddings washes the target
            # into something generic, which flattens the gradient signal and
            # produces heatmaps that barely respond to image content.
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

    def explain_batch(self, image_bytes: bytes, spot_indices: list[int],
                       gene: str | None = None) -> list[TileResult]:
        """
        Grad-CAM overlays for several tissue patches in one forward/backward
        pass — the whole-slide mosaic needs this once per tissue tile, and
        one call per tile (explain()) pays the encoder's per-call overhead
        every single time. Batching cuts that to one payment per
        BATCH_SIZE tiles.

        gene, if given, targets every tile in the batch against the SAME
        independent reference (the one reference spot with the highest
        REAL measured expression of that gene) — same target explain()
        uses for its single-tile gene-targeted mode, just shared across
        the whole batch instead of picked per spot_index.

        Without a gene, falls back to each tile's own single nearest
        retrieved neighbour (explain()'s original gene=None rule) — kept
        for API completeness, but a deletion-test sensitivity check
        (occlude the region Grad-CAM flags as important vs. an unimportant
        region, compare how much each hurts the score) showed this
        self-referential target is measurably weaker: a spot's own nearest
        neighbour is, by construction, already close to that spot's own
        maximum similarity, and cosine similarity's gradient shrinks right
        at its own peak — the same mechanism behind the all-zero-heatmap
        case in generate_batch(). An independent, externally-chosen target
        (like a fixed gene's reference spot) doesn't start near its own
        maximum for an arbitrary patch, so the gradient stays meaningful.
        Measured: self-referential target scored ~0.9x (occluding the
        "important" region hurt the score about as much as occluding an
        "unimportant" one — no better than chance) vs ~1.9x, up to 22x on
        individual spots, for an independent gene target on the same
        image. The whole-slide mosaic should pass a gene here (e.g. the
        slide's own top predicted gene, so the caller still doesn't need
        to expose gene selection as a UI control) rather than rely on the
        fallback.

        Returns a TileResult per spot_index (png, raw peak, and the raw heat
        grid plus tissue mask so a client can stitch every tile into one
        continuous map). Each overlay's
        own heatmap is independently normalised to its own peak (so it
        reads correctly on its own), which means colour intensity can't be
        compared spot-to-spot — raw_peak is the pre-normalisation strength,
        for a caller that wants to do that comparison itself (e.g. scaling
        each spot's overlay opacity against the slide's strongest spot so
        far, instead of every spot always looking equally "hot").
        """
        if not self.is_loaded:
            raise RuntimeError("Predictor not loaded")
        if self._gradcam is None:
            raise NotImplementedError(
                f"Grad-CAM has no target layer for the {self.encoder_backend} encoder")

        patches, kept = self._get_tiles(image_bytes)

        for si in spot_indices:
            if not (0 <= si < len(kept)):
                raise ValueError(
                    f"spot_index {si} out of range — this image has "
                    f"{len(kept)} tissue tiles (0..{len(kept) - 1})")

        batch_patches = [patches[kept[si]] for si in spot_indices]

        if self.encoder_backend == "h0mini":
            return self._explain_batch_h0mini(batch_patches, spot_indices, kept, gene)

        tensors = [
            torch.from_numpy(np.array(p.convert("RGB"), dtype=np.float32) / 255.0)
            .permute(2, 0, 1)
            for p in batch_patches
        ]
        image_batch = torch.stack(tensors).to(self.device)   # (N, 3, 224, 224)

        if gene is not None:
            if gene not in self.genes:
                raise ValueError(f"Unknown gene {gene!r}")
            gene_idx = self.genes.index(gene)
            top_idx = int(np.argmax(self.expr_key[:, gene_idx]))
            target = torch.from_numpy(
                self.spot_key[top_idx:top_idx + 1]
            ).float().to(self.device)
            target_batch = target.repeat(len(spot_indices), 1)    # (N, 256), same target every row
        else:
            # Own-nearest-neighbour target per tile, same rule as explain()'s
            # gene=None branch — just found for the whole batch's forward pass
            # at once instead of one tile at a time. See docstring: measurably
            # weaker signal, kept only as a fallback.
            with torch.no_grad():
                query = self._model.image_projection(
                    self._model.image_encoder(image_batch)).cpu().numpy()
            qn = query / np.linalg.norm(query, axis=1, keepdims=True)
            sim = qn @ self.spot_key_n.T                          # (N, 11548)
            nn_idx = np.argmax(sim, axis=1)
            target_batch = torch.from_numpy(
                self.spot_key[nn_idx]
            ).float().to(self.device)                              # (N, 256)

        heatmaps, peaks = self._gradcam.generate_batch(image_batch, target_batch)  # (N, 7, 7), (N,)

        return [tile_result(patch, heatmaps[i], peaks[i])
                for i, patch in enumerate(batch_patches)]

    def _explain_batch_h0mini(self, batch_patches, spot_indices, kept,
                              gene: str | None) -> list[TileResult]:
        """v7 path of explain_batch(): same targets, same overlay, but the
        embedding being explained is the dual-crop one (native ++ context)
        and the heatmap comes from ViTGradCAM."""
        _, _, _, image, coords = self._tile_cache
        context_patches = self._tile_context(
            image, [coords[kept[si]] for si in spot_indices])
        with torch.no_grad():
            context_feats = self._encoder.encode(context_patches)          # (N, 1536)

        if gene is not None:
            if gene not in self.genes:
                raise ValueError(f"Unknown gene {gene!r}")
            top_idx = int(np.argmax(self.expr_key[:, self.genes.index(gene)]))
            target = torch.from_numpy(self.spot_key[top_idx:top_idx + 1]).float()
            target_batch = target.repeat(len(spot_indices), 1)
        else:
            # Own-nearest-neighbour fallback — see explain_batch()'s note on
            # why an independent gene target is the better default.
            query = self._encode(batch_patches, context_patches)
            qn = query / np.linalg.norm(query, axis=1, keepdims=True)
            nn_idx = np.argmax(qn @ self.spot_key_n.T, axis=1)
            target_batch = torch.from_numpy(self.spot_key[nn_idx]).float()

        heatmaps, peaks = self._gradcam.generate_batch(
            batch_patches, context_feats, target_batch.to(self.device))    # (N, 16, 16), (N,)

        return [tile_result(patch, heatmaps[i], peaks[i])
                for i, patch in enumerate(batch_patches)]

def get_predictor(settings) -> BasePredictor:
    # Checked first: a Modal deploy needs no torch/H0-mini/reference-bank on
    # this host at all, so this branch must win over use_dummy_predictor and
    # never fall through to loading a local model "as well".
    if settings.use_modal_inference:
        from app.services.modal_predictor import ModalPredictor
        return ModalPredictor(
            predict_url=settings.modal_predict_url,
            health_url=settings.modal_health_url,
            supabase_url=settings.supabase_url,
            supabase_service_role_key=settings.supabase_service_role_key,
            relay_bucket=settings.supabase_relay_bucket,
            request_timeout=settings.modal_request_timeout,
            gradcam_url=settings.modal_gradcam_url)
    if settings.use_dummy_predictor:
        return DummyPredictor()
    return MclSTExpPredictor(
        settings.model_checkpoint_path, settings.model_data_root,
        enable_smoothing=settings.enable_smoothing,
        smoothing_alpha=settings.smoothing_alpha,
        encoder_backend=settings.encoder_backend,
        tissue_classifier_enabled=settings.tissue_classifier_enabled,
        tissue_classifier_dir=settings.tissue_classifier_dir,
        hf_token=settings.hf_token)
