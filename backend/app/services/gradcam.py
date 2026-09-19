"""
Grad-CAM for the mclSTExp image encoder.

Adapted from the exploratory notebook (MDS_Gradcam_Test.ipynb): hooks the
last DenseNet dense block, backprops the cosine similarity between a patch's
embedding and the mean embedding of its retrieved nearest-neighbour spots,
and overlays the resulting heatmap on the patch.
"""
import io

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, ImageFilter


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
