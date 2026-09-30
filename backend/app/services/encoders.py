"""
Image encoders that produce the raw feature vector image_projection (or the
standalone ProjectionHead, for v7/h0mini) expects.

Two backends:
  - densenet121: the trained checkpoint's own image_encoder submodule. Query
    patches are RAW [0,1] tensors, NO normalisation — the checkpoint was
    trained with ToTensor() only (see predictor.py's _encode()). Do NOT add
    transforms.Normalize here; it silently degrades every prediction.
  - h0mini: bioptimus/H0-mini (frozen, downloaded from HuggingFace on first
    use — needs an HF_TOKEN with access to the gated repo), CLS + mean
    patch-token readout (768+768=1536-d), its own normalisation stats — NOT
    ImageNet's. This is the v7 dual-crop architecture (MDS19_Deployment_Brief
    .md §3): predictor.py encodes a native 224px crop AND a 672px context
    crop (resized to 224, bicubic) separately through this encoder, then
    concatenates native-first into the 3072-d input the v7 checkpoint's
    projection head expects.

Getting the h0mini crop size, normalisation stats, or token pooling wrong is
silent — predictions still render, they are just wrong. This module's h0mini
path must match scripts/cosine_check_a2.py exactly; that script is the
preprocessing proof, run before anything else when deploying a new h0mini
checkpoint.
"""
import numpy as np
import torch

H0MINI_FEATURE_DIM = 1536                      # CLS (768) + mean patch tokens (768)
H0MINI_CONTEXT_MULTIPLIER = 3                  # 672 / 224 — v7's wide context crop
H0MINI_COMBINED_DIM = H0MINI_FEATURE_DIM * 2   # native ++ context, 3072-d

H0MINI_MEAN = (0.707223, 0.578729, 0.703617)
H0MINI_STD = (0.211883, 0.230117, 0.177517)
H0MINI_NUM_PREFIX_TOKENS = 5
H0MINI_REPO = "hf-hub:bioptimus/H0-mini"


class DenseNetEncoder:
    """Wraps the checkpoint's own image_encoder submodule. RAW [0,1] tensors,
    no normalisation — see module docstring."""

    def __init__(self, model, device: str):
        self._image_encoder = model.image_encoder
        self.device = device

    def encode(self, patches) -> torch.Tensor:
        batch = torch.stack([
            torch.from_numpy(np.array(p.convert("RGB"), dtype=np.float32) / 255.0)
                 .permute(2, 0, 1)
            for p in patches
        ]).to(self.device)
        return self._image_encoder(batch)


class H0MiniEncoder:
    """Frozen bioptimus/H0-mini, CLS + mean-patch-token readout."""

    def __init__(self, device: str):
        import timm
        self.device = device
        self._model = timm.create_model(
            H0MINI_REPO, pretrained=True,
            mlp_layer=timm.layers.SwiGLUPacked, act_layer=torch.nn.SiLU,
        ).eval().to(device)
        n_prefix = getattr(self._model, "num_prefix_tokens", None)
        if n_prefix is not None and n_prefix != H0MINI_NUM_PREFIX_TOKENS:
            raise RuntimeError(
                f"H0-mini reports num_prefix_tokens={n_prefix}, expected "
                f"{H0MINI_NUM_PREFIX_TOKENS} — token layout has changed, "
                f"re-derive the readout before trusting anything else here.")
        self._mean = torch.tensor(H0MINI_MEAN, device=device).view(1, 3, 1, 1)
        self._std = torch.tensor(H0MINI_STD, device=device).view(1, 3, 1, 1)

    def preprocess(self, patches) -> torch.Tensor:
        """PIL patches -> normalised (B, 3, 224, 224) batch on self.device.
        Shared by encode() and Grad-CAM (gradcam.ViTGradCAM) so both see
        exactly the same input — the h0mini preprocessing is the silent-
        failure part of this pipeline (see module docstring)."""
        batch = torch.stack([
            torch.from_numpy(np.array(p.convert("RGB"), dtype=np.float32) / 255.0)
                 .permute(2, 0, 1)
            for p in patches
        ]).to(self.device)
        return (batch - self._mean) / self._std

    @staticmethod
    def readout(tokens: torch.Tensor) -> torch.Tensor:
        """Final ViT tokens (B, 5+256, 768) -> (B, 1536): CLS ++ mean of the
        patch tokens (the 4 register tokens are excluded)."""
        cls = tokens[:, 0]
        patch_mean = tokens[:, H0MINI_NUM_PREFIX_TOKENS:].mean(1)
        return torch.cat([cls, patch_mean], dim=-1)

    def encode(self, patches) -> torch.Tensor:
        tokens = self._model.forward_features(self.preprocess(patches))  # (B, 261, 768)
        return self.readout(tokens)                                       # (B, 1536)


def build_encoder(backend: str, model, device: str):
    """
    model is the loaded mclSTExp_Attention — only used by the densenet121
    path, which encodes through the checkpoint's own submodule. The h0mini
    path ignores it: H0-mini is a separate frozen network, downloaded fresh.
    """
    if backend == "densenet121":
        return DenseNetEncoder(model, device)
    if backend == "h0mini":
        return H0MiniEncoder(device)
    raise ValueError(f"unknown encoder backend: {backend!r}")
