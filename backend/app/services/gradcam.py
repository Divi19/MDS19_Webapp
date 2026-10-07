"""
Grad-CAM for the mclSTExp image encoder.

Adapted from the exploratory notebook (MDS_Gradcam_Test.ipynb): hooks the
last DenseNet dense block, backprops the cosine similarity between a patch's
embedding and the mean embedding of its retrieved nearest-neighbour spots,
and overlays the resulting heatmap on the patch.
"""
import io
from dataclasses import dataclass

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, ImageFilter


@dataclass
class TileResult:
    """One tile's Grad-CAM output.

    png/peak are the server-rendered overlay (normalised to the tile's own
    peak) and that peak. heat/mask let a client draw all tiles as ONE
    continuous map instead: heat is the raw, pre-normalisation CAM (h, w),
    in the same units for every tile because the network and the target
    embedding are shared; mask is the soft tissue fraction per heat cell.
    Both are None when the producer cannot supply them (an older remote
    service).
    """
    png: bytes
    peak: float
    heat: np.ndarray | None = None
    mask: np.ndarray | None = None


def pooled_mask(patch: Image.Image, shape: tuple[int, int]) -> np.ndarray:
    """tissue_pixel_mask(patch) averaged down to the heatmap's own grid."""
    m = torch.from_numpy(tissue_pixel_mask(patch))[None, None].float()
    return F.adaptive_avg_pool2d(m, shape)[0, 0].numpy()


def tile_result(patch: Image.Image, heat_norm: np.ndarray, peak: float) -> TileResult:
    """Overlay PNG (as before) plus the raw heat and pooled tissue mask."""
    mask_px = tissue_pixel_mask(patch)
    overlay = overlay_heatmap(patch, heat_norm, tissue_mask=mask_px)
    return TileResult(
        png=encode_png(overlay), peak=float(peak),
        heat=(heat_norm * float(peak)).astype(np.float32),
        mask=pooled_mask(patch, heat_norm.shape).astype(np.float32))


def tile_json(spot_index: int, t: TileResult) -> dict:
    """Wire format shared by the Render route and the Modal endpoint. heat and
    mask are flat row-major lists (rounded to keep the payload small) with
    heat_size = [h, w]; they are omitted when the tile has none."""
    import base64
    out = {"spot_index": spot_index,
           "png_base64": base64.b64encode(t.png).decode("ascii"),
           "peak": t.peak}
    if t.heat is not None and t.mask is not None:
        out["heat_size"] = [int(t.heat.shape[0]), int(t.heat.shape[1])]
        out["heat"] = [float(f"{v:.4g}") for v in t.heat.reshape(-1)]
        out["mask"] = [round(float(v), 2) for v in t.mask.reshape(-1)]
    return out


def tile_from_json(d: dict) -> TileResult:
    """Inverse of tile_json (used by ModalPredictor); tolerates a remote that
    does not send heat/mask yet."""
    import base64
    heat = mask = None
    if d.get("heat") and d.get("mask") and d.get("heat_size"):
        shape = tuple(int(x) for x in d["heat_size"])
        heat = np.asarray(d["heat"], dtype=np.float32).reshape(shape)
        mask = np.asarray(d["mask"], dtype=np.float32).reshape(shape)
    return TileResult(png=base64.b64decode(d["png_base64"]), peak=float(d["peak"]),
                      heat=heat, mask=mask)


class GradCAM:
    def __init__(self, model, target_layer):
        self.model = model
        self.gradients = None
        self.activations = None
        target_layer.register_forward_hook(self._save_activation)
        target_layer.register_full_backward_hook(self._save_gradient)

    def _save_activation(self, module, inp, out):
        self.activations = out

    def _save_gradient(self, module, grad_in, grad_out):
        self.gradients = grad_out[0].detach()

    def generate(self, image_tensor: torch.Tensor, target_embedding: torch.Tensor) -> np.ndarray:
        """
        image_tensor: (1, 3, H, W), 0-1 range, on the model's device.
        target_embedding: (1, projection_dim) — what the patch embedding is
            scored against (mean embedding of its retrieved nearest neighbours).

        Returns a (h, w) heatmap normalised to [0, 1] at the target layer's
        spatial resolution (7x7 for DenseNet121 @ 224px input).
        """
        self.model.zero_grad()
        image_tensor = image_tensor.requires_grad_(True)

        feats = self.model.image_encoder(image_tensor)
        emb = self.model.image_projection(feats)
        score = F.cosine_similarity(emb, target_embedding, dim=-1).squeeze()
        score.backward()

        if self.gradients is None or self.activations is None:
            raise RuntimeError("Grad-CAM hooks did not fire — check target_layer")

        pooled = self.gradients.mean(dim=(0, 2, 3))
        acts = self.activations[0].detach().clone()
        for c in range(acts.shape[0]):
            acts[c] *= pooled[c]

        heatmap = acts.sum(dim=0).cpu().numpy()
        heatmap = np.maximum(heatmap, 0)
        peak = heatmap.max()
        if peak <= 0:
            raise RuntimeError("Grad-CAM heatmap is all-zero for this patch")
        return heatmap / (peak + 1e-8)

    def generate_batch(self, image_batch: torch.Tensor, target_batch: torch.Tensor) -> tuple[np.ndarray, np.ndarray]:
        """
        Same as generate(), but for several patches in one forward/backward
        pass instead of one call per patch — the whole-slide mosaic needs
        this once per tissue tile, and the per-call overhead (kernel
        launches, Python-level dispatch) otherwise dominates at that scale.

        image_batch: (N, 3, H, W). target_batch: (N, projection_dim), each
        row is that item's own target embedding (not shared across the
        batch). Batch items are independent through conv/batchnorm-in-eval,
        so summing the per-item scores before backward() gives each item
        its own correct gradient — not an average blended across the batch.

        Returns (heatmaps, peaks):
        - heatmaps: (N, h, w), each independently normalised to [0, 1]. A
          batch item whose gradient is all-zero or negative (its own
          nearest neighbour is itself or a near-identical twin — cosine
          similarity's gradient vanishes near its own maximum) comes back
          as an all-zero heatmap rather than raising: at single-tile scale
          that was rare enough to treat as an error, but batching means
          one such tile would otherwise take its whole batch down with it.
          An all-zero heatmap overlays as uniform lowest-attention colour,
          an honest rendering of "no differentiated gradient signal here".
        - peaks: (N,) each item's RAW pre-normalisation peak — since every
          heatmap above gets independently rescaled to its own max, this is
          the only place the caller can still tell a strong spot from a
          weak one; heatmaps alone can't be compared spot-to-spot.
        """
        self.model.zero_grad()
        image_batch = image_batch.requires_grad_(True)

        feats = self.model.image_encoder(image_batch)
        emb = self.model.image_projection(feats)
        scores = F.cosine_similarity(emb, target_batch, dim=-1)  # (N,)
        scores.sum().backward()

        if self.gradients is None or self.activations is None:
            raise RuntimeError("Grad-CAM hooks did not fire — check target_layer")

        pooled = self.gradients.mean(dim=(2, 3))            # (N, C)
        acts = self.activations.detach().clone()            # (N, C, h, w)
        weighted = acts * pooled[:, :, None, None]
        heatmaps = weighted.sum(dim=1)                       # (N, h, w)
        heatmaps = torch.clamp(heatmaps, min=0).cpu().numpy()

        peaks = heatmaps.max(axis=(1, 2))
        out = np.zeros_like(heatmaps)
        for i in range(heatmaps.shape[0]):
            if peaks[i] > 0:
                out[i] = heatmaps[i] / (peaks[i] + 1e-8)
        return out, peaks


class ViTGradCAM:
    """
    Grad-CAM for the v7 (H0-mini) encoder — same idea as GradCAM above, but
    the target layer is the last transformer block, whose output is a token
    sequence (B, 5 + 256, 768) rather than a conv feature map.

    The 5 prefix tokens (CLS + 4 registers) are dropped and the 256 patch
    tokens are reshaped to a 16x16 grid (224px / 14px patches). Channel
    weights are the gradient pooled over the patch tokens; the heatmap is
    ReLU(sum_c weight_c * activation_c) — the standard Grad-CAM recipe with a
    reshape from tokens to a grid (as in pytorch-grad-cam's ViT example).

    What gets scored is the real v7 embedding: the native crop's 1536-d
    feature ++ its context crop's 1536-d feature -> image_projection ->
    cosine against the target. The context feature is passed in as a
    constant (no gradient): the heatmap explains the native 224px tile the
    user is looking at, not the wider context window around it.
    """

    def __init__(self, encoder, projection):
        self.encoder = encoder            # encoders.H0MiniEncoder
        self.projection = projection      # ProjectionHead, 3072 -> 256
        self.activations = None
        vit = encoder._model
        # Only the input needs gradients, not the frozen weights — skips all
        # the weight-gradient work in backward().
        for prm in vit.parameters():
            prm.requires_grad_(False)
        vit.blocks[-1].register_forward_hook(self._save_activation)

    def _save_activation(self, module, inp, out):
        self.activations = out

    def generate_batch(self, patches, context_feats: torch.Tensor,
                       target_batch: torch.Tensor) -> tuple[np.ndarray, np.ndarray]:
        """
        patches: N PIL native 224px crops. context_feats: (N, 1536), the
        encoder's features for each tile's context crop (computed by the
        caller, no grad). target_batch: (N, 256), one target embedding per
        item. Same return contract as GradCAM.generate_batch: (heatmaps
        (N, 16, 16) each normalised to [0, 1], raw peaks (N,)) — an item
        with no positive signal comes back all-zero instead of raising.
        """
        from app.services.encoders import H0MINI_NUM_PREFIX_TOKENS

        vit = self.encoder._model
        x = self.encoder.preprocess(patches).requires_grad_(True)

        with torch.enable_grad():
            tokens = vit.forward_features(x)                              # (N, 261, 768)
            feats = self.encoder.readout(tokens)                          # (N, 1536)
            emb = self.projection(torch.cat([feats, context_feats.to(feats.device)], dim=1))
            scores = F.cosine_similarity(emb, target_batch, dim=-1)       # (N,)
            acts = self.activations                                       # (N, 261, 768)
            (grads,) = torch.autograd.grad(scores.sum(), acts)

        n_patch = acts.shape[1] - H0MINI_NUM_PREFIX_TOKENS
        side = int(round(n_patch ** 0.5))
        if side * side != n_patch:
            raise RuntimeError(f"{n_patch} patch tokens do not form a square grid")

        acts = acts.detach()[:, H0MINI_NUM_PREFIX_TOKENS:]                # (N, 256, 768)
        grads = grads[:, H0MINI_NUM_PREFIX_TOKENS:]
        weights = grads.mean(dim=1, keepdim=True)                         # (N, 1, 768)
        cam = torch.clamp((acts * weights).sum(dim=-1), min=0)            # (N, 256)
        heatmaps = cam.reshape(-1, side, side).cpu().numpy()

        peaks = heatmaps.max(axis=(1, 2))
        out = np.zeros_like(heatmaps)
        for i in range(heatmaps.shape[0]):
            if peaks[i] > 0:
                out[i] = heatmaps[i] / (peaks[i] + 1e-8)
        return out, peaks


def _jet(x: np.ndarray) -> np.ndarray:
    """Vectorised approximation of matplotlib's 'jet' colormap.

    x in [0, 1], returns (..., 3) in [0, 1]. Avoids adding matplotlib as a
    backend dependency for a single colormap.
    """
    r = np.clip(1.5 - np.abs(4 * x - 3), 0, 1)
    g = np.clip(1.5 - np.abs(4 * x - 2), 0, 1)
    b = np.clip(1.5 - np.abs(4 * x - 1), 0, 1)
    return np.stack([r, g, b], axis=-1)


def tissue_pixel_mask(patch: Image.Image, sat_thresh: float = 0.10,
                       downsample: int = 8) -> np.ndarray:
    """Soft [0, 1] tissue mask via HSV saturation, at the patch's own
    resolution.

    Thresholding is done on a DOWNSAMPLED saturation map, then upsampled
    back with bilinear interpolation — not thresholded pixel-by-pixel at
    full resolution. A per-pixel threshold is noisy (compression artefacts,
    the scanner's faint background dot pattern each independently flip
    in/out of "tissue"), which produced a jagged, speckled mask boundary.
    Downsampling first averages that noise out, and the bilinear upsample
    turns the boundary into a smooth 0→1 ramp instead of a hard edge, so
    overlay_heatmap's blend fades out approaching the tissue edge rather
    than cutting off in a staircase.

    Used to suppress Grad-CAM on background pixels within an otherwise-kept
    tile (see overlay_heatmap below), not to decide whether to keep the tile
    — that's still predictor.tissue_tile_mask()'s job.
    """
    w, h = patch.size
    small = patch.convert("RGB").convert("HSV").resize(
        (max(1, w // downsample), max(1, h // downsample)), Image.BILINEAR)
    sat = np.asarray(small)[:, :, 1].astype(np.float32) / 255.0
    coarse = (sat > sat_thresh).astype(np.uint8) * 255
    coarse_img = Image.fromarray(coarse)

    # Morphological opening (erode, dilate) drops small isolated blobs — a
    # scanner's faint background dot pattern can locally cross the
    # saturation threshold even after downsampling — then closing (dilate,
    # erode) fills small holes inside the real tissue mass.
    if min(coarse_img.size) >= 3:
        coarse_img = coarse_img.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))
        coarse_img = coarse_img.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.MinFilter(3))

    mask_img = coarse_img.resize((w, h), Image.BILINEAR)
    return np.asarray(mask_img, dtype=np.float32) / 255.0


def overlay_heatmap(patch: Image.Image, heatmap: np.ndarray, alpha: float = 0.4,
                     tissue_mask: np.ndarray | None = None) -> Image.Image:
    """Resizes heatmap to the patch size and alpha-blends a jet colormap over it.

    tissue_mask, if given (same H, W as patch, values in [0, 1]), scales
    the BLEND ITSELF by the mask, not just the heatmap value that goes into
    the colormap — the jet colormap at heatmap value 0 is dark blue, not
    transparent, so zeroing the heatmap alone still paints every background
    pixel a uniform dark-blue wash. Scaling alpha per-pixel instead makes
    background pixels come out as the original image, untouched, while
    tissue pixels get the normal blend (and the mask's soft edge, see
    tissue_pixel_mask, fades the blend out smoothly at the tissue boundary).

    Without this, background can still show up "hot": DenseNet's
    ImageNet-pretrained features react strongly to blank slide background
    simply because they never saw anything like it during training, not
    because it's biologically salient — background can never be a
    meaningful explanation for a gene-expression prediction.
    """
    w, h = patch.size
    hm = F.interpolate(
        torch.from_numpy(heatmap)[None, None].float(), size=(h, w),
        mode="bilinear", align_corners=False)[0, 0].numpy()

    if tissue_mask is not None:
        hm = hm * tissue_mask
        peak = hm.max()
        if peak > 0:
            hm = hm / peak
        blend = (alpha * tissue_mask)[:, :, None]
    else:
        blend = alpha

    img = np.asarray(patch.convert("RGB"), dtype=np.float32) / 255.0
    colored = _jet(hm)
    out = (1 - blend) * img + blend * colored
    return Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8))


def encode_png(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()
