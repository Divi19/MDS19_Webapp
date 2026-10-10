"""
Grad-CAM for v16-core, served from a Modal T4 GPU.

Replaces the v7 Grad-CAM app. Explains the REGRESSOR half of v16-core (80% of
the blend): for one spot and one gene, how much each region of the spot's
224 px crop (and of its 672 px context crop) drives the regressor's prediction.
The retrieval half (20%) is not explained.

Deploy (from the backend/ folder):

    MDS19_MODAL_VOLUME=mds19-model-data MDS19_HF_SECRET=huggingface-secret \
        modal deploy modal_gradcam_app.py

Health:  https://brandonchiew--mds19-v7-gradcam-v7gradcam-health.modal.run
         (app/class names are unchanged, so the URL Render already uses still works)

Tiling, tissue mask, context crops and spot order are the SAME code as infer.py
(290 px grid), so `spot_index` here is exactly the index in predict's "spots".

Endpoint: POST {"image_url", "spot_indices": [...], "gene": "ERBB2"|null}
      ->  {"tiles": [{"spot_index", "png_base64", "peak", "heat", "mask", "heat_size"}, ...]}
Same shape as before. gene=null falls back to the slide's top predicted gene
(the regressor needs a gene to explain). "peak" is the RAW pre-normalisation
Grad-CAM peak, comparable between spots for the same gene.
"""
import io
import os
from pathlib import Path

import modal
from PIL import Image, ImageOps

VOLUME_NAME = os.environ.get("MDS19_MODAL_VOLUME", "mds19-model-data")
HF_SECRET = os.environ.get("MDS19_HF_SECRET", "huggingface-secret")
DATA_DIR = "/data"
V16_DIR = f"{DATA_DIR}/v16core_production"

HERE = Path(__file__).parent

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libgl1", "libglib2.0-0")
    .pip_install(
        "torch", "torchvision", "timm", "einops", "scipy", "numpy", "pillow",
        "requests", "huggingface_hub", "fastapi[standard]",
    )
    .add_local_dir(HERE / "app", remote_path="/root/app",
                   ignore=["**/__pycache__", "**/*.pyc", "main.py", "api/**"])
)

app = modal.App("mds19-v7-gradcam")      # name kept: the URLs Render calls do not change
volume = modal.Volume.from_name(VOLUME_NAME)

H0MINI_MEAN = (0.707223, 0.578729, 0.703617)
H0MINI_STD = (0.211883, 0.230117, 0.177517)
H0MINI_NUM_PREFIX_TOKENS = 5
H0MINI_REPO = "hf-hub:bioptimus/H0-mini"
H0MINI_CONTEXT_MULTIPLIER = 3

PATCH = 224                 # spot crop (154 um at ~0.69 um/px)
STRIDE = 290                # tile-centre spacing: 200 um at ~0.69 um/px (was 224)
CONTEXT_MULTIPLIER = H0MINI_CONTEXT_MULTIPLIER
MAX_TISSUE_TILES = 4000     # GPU sanity guard; the regressor was trained on 250-700 spot sections


def tile_image(pil_image, patch=PATCH, stride=STRIDE):
    """Square grid of patch x patch crops, tile origins `stride` px apart.
    coords are the INTEGER (column, row) grid indices the regressor expects."""
    w, h = pil_image.size
    patches, coords = [], []
    for iy, y in enumerate(range(0, h - patch + 1, stride)):
        for ix, x in enumerate(range(0, w - patch + 1, stride)):
            patches.append(pil_image.crop((x, y, x + patch, y + patch)))
            coords.append((ix, iy))
    return patches, coords


def tile_context(pil_image, coords, patch=PATCH, stride=STRIDE,
                 multiplier=CONTEXT_MULTIPLIER):
    """672 px crop centred on each tile's centre, resized to 224 (bicubic)."""
    context_crop = patch * multiplier
    patches = []
    for ix, iy in coords:
        x, y = ix * stride, iy * stride
        cx, cy = x + patch / 2, y + patch / 2
        half = context_crop / 2
        box = tuple(round(v) for v in (cx - half, cy - half, cx + half, cy + half))
        p = pil_image.crop(box)
        if context_crop != patch:
            p = p.resize((patch, patch), Image.BICUBIC)
        patches.append(p)
    return patches


def tissue_tile_mask(pil_image, patch=PATCH, stride=STRIDE, sat_thresh=0.18,
                     min_frac=0.25, downsample=8):
    """Which grid tiles contain tissue (HSV saturation of a downsampled image)."""
    import numpy as np
    w, h = pil_image.size
    small = pil_image.convert("RGB").convert("HSV").resize(
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


@app.cls(
    gpu="T4",
    image=image,
    volumes={DATA_DIR: volume},
    secrets=[modal.Secret.from_name(HF_SECRET)],
    timeout=900,
    # One warm container keeps the slide's features cached between the many
    # batch requests a whole-slide mosaic makes.
    max_containers=1,
    scaledown_window=300,
)
class V7GradCam:     # class name kept: part of the endpoint URLs
    @modal.enter()
    def load(self):
        import sys

        import timm
        import torch

        self.device = "cuda"
        if not torch.cuda.is_available():
            raise RuntimeError("No GPU visible in this container")
        self.h0mini = timm.create_model(
            H0MINI_REPO, pretrained=True,
            mlp_layer=timm.layers.SwiGLUPacked, act_layer=torch.nn.SiLU,
        ).eval().to(self.device)
        for p in self.h0mini.parameters():      # only the input needs gradients
            p.requires_grad_(False)
        n_prefix = getattr(self.h0mini, "num_prefix_tokens", None)
        if n_prefix is not None and n_prefix != H0MINI_NUM_PREFIX_TOKENS:
            raise RuntimeError(f"H0-mini num_prefix_tokens={n_prefix}, expected {H0MINI_NUM_PREFIX_TOKENS}")
        self.mean = torch.tensor(H0MINI_MEAN, device=self.device).view(1, 3, 1, 1)
        self.std = torch.tensor(H0MINI_STD, device=self.device).view(1, 3, 1, 1)

        sys.path.insert(0, V16_DIR)
        import v16core_inference as V
        self.V = V
        self.core = V.V16Core(V16_DIR, device=self.device)
        for p in self.core.reg.parameters():
            p.requires_grad_(False)
        self.slide = None          # one-slot cache, keyed by the URL path
        print(f"gradcam loaded {V.VERSION}: {len(self.core.genes)} genes, device={self.device}")

    # ------------------------------------------------------------------
    def _encode(self, patches, batch_size=128):
        import numpy as np
        import torch
        out = []
        with torch.inference_mode(), torch.autocast(device_type="cuda", dtype=torch.float16):
            for i in range(0, len(patches), batch_size):
                chunk = patches[i:i + batch_size]
                batch = torch.stack([
                    torch.from_numpy(np.array(p.convert("RGB"), dtype=np.float32) / 255.0).permute(2, 0, 1)
                    for p in chunk]).to(self.device)
                tokens = self.h0mini.forward_features((batch - self.mean) / self.std)
                feats = torch.cat([tokens[:, 0], tokens[:, H0MINI_NUM_PREFIX_TOKENS:].mean(1)], dim=-1)
                out.append(feats.float().cpu().numpy())
        return np.concatenate(out, axis=0)

    def _load_slide(self, url: str):
        """Download + tile + encode the whole slide once; cached for the next batches."""
        import numpy as np
        import requests
        import torch

        key = url.split("?", 1)[0]       # the signed query string changes, the path does not
        if self.slide is not None and self.slide["key"] == key:
            return self.slide

        resp = requests.get(url, timeout=120)
        resp.raise_for_status()
        img = Image.open(io.BytesIO(resp.content))
        img.load()
        img = ImageOps.exif_transpose(img)            # same orientation handling as predict

        patches, coords = tile_image(img)
        if not patches:
            w, h = img.size
            raise ValueError(f"Image is {w}x{h}px — too small to tile into {PATCH}x{PATCH} patches")
        keep = tissue_tile_mask(img)
        kept = [i for i, c in enumerate(coords) if keep[c]]
        if not kept:
            raise ValueError(f"No tissue detected in any of the {len(patches)} tiles")
        if len(kept) > MAX_TISSUE_TILES:
            raise ValueError(f"Slide requires {len(kept)} tissue patches, over the {MAX_TISSUE_TILES} guard")
        patches = [patches[i] for i in kept]
        coords = [coords[i] for i in kept]
        ctx = tile_context(img, coords)

        h0 = self._encode(patches)
        w672 = self._encode(ctx)
        grid = np.asarray(coords, dtype=np.int64)

        # tensors the regressor needs, built once per slide
        pe, nb = self.V.slide_inputs(grid, self.core.rc, self.device)
        slide = dict(key=key, patches=patches, ctx=ctx, grid=grid, h0=h0, w672=w672,
                     XT=self.core._x(h0), XC=self.core._x(w672), pe=pe, nb=nb, top_gene=None)

        # slide's top predicted gene (fallback when the caller sends no gene)
        pred = self.core.predict(h0, w672, grid)
        slide["top_gene"] = self.core.genes[int(np.argmax(pred.mean(axis=0)))]
        self.slide = slide
        return slide

    def _cam_one(self, slide, i: int, gi: int):
        """Grad-CAM of the regressor's prediction of gene gi at spot i, on the SPOT crop.
        Returns (raw 16x16 cam, peak). Same method as v16core_inference.gradcam_regressor
        but the raw peak is kept (that function normalises it away) and the
        slide-level tensors are reused instead of rebuilt per spot."""
        import numpy as np
        import torch
        import torch.nn.functional as F

        enc = self.h0mini
        npre = H0MINI_NUM_PREFIX_TOKENS
        store = {}
        hk = enc.blocks[-1].register_forward_hook(lambda m, inp, out: store.__setitem__("a", out))
        try:
            with torch.enable_grad():
                crops = [np.asarray(slide["patches"][i].convert("RGB"), dtype=np.float32),
                         np.asarray(slide["ctx"][i].convert("RGB"), dtype=np.float32)]
                x = torch.from_numpy(np.stack(crops)).permute(0, 3, 1, 2).to(self.device) / 255.0
                x = ((x - self.mean) / self.std).requires_grad_(True)
                tok = enc.forward_features(x).float()
                a = store["a"]
                a.retain_grad()
                feat = torch.cat([tok[:, 0], tok[:, npre:].mean(1)], 1)
                XT, XC = slide["XT"], slide["XC"]
                XT = torch.cat([XT[:i], feat[0:1], XT[i + 1:]])
                XC = torch.cat([XC[:i], feat[1:2], XC[i + 1:]])
                out = self.core.reg(XT, XC, slide["pe"], slide["nb"])[0][i, gi]
                out.backward()
        finally:
            hk.remove()
        A = a.detach()[:, npre:].float()
        G = a.grad[:, npre:].float()
        cam = F.relu((A * G.mean(1, keepdim=True)).sum(-1))[0]      # spot crop only, (256,)
        side = int(round(cam.shape[0] ** 0.5))
        cam = cam.reshape(side, side).cpu().numpy()
        return cam, float(cam.max())

    # ------------------------------------------------------------------
    @modal.fastapi_endpoint(method="POST")
    def explain_batch(self, item: dict):
        import numpy as np
        from fastapi import HTTPException

        from app.services.gradcam import tile_json, tile_result

        url = item.get("image_url")
        indices = item.get("spot_indices") or []
        gene = item.get("gene") or None
        if not url or not indices:
            raise HTTPException(status_code=400, detail="image_url and spot_indices are required")

        try:
            slide = self._load_slide(url)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

        n = len(slide["patches"])
        for si in indices:
            if not (0 <= int(si) < n):
                raise HTTPException(
                    status_code=400,
                    detail=f"spot_index {si} out of range — this image has {n} tissue tiles (0..{n - 1})")

        if gene is None:
            gene = slide["top_gene"]
        if gene not in self.core.genes:
            raise HTTPException(status_code=400, detail=f"Unknown gene {gene!r}")
        gi = self.core.genes.index(gene)

        tiles = []
        for si in indices:
            si = int(si)
            cam, peak = self._cam_one(slide, si, gi)
            norm = cam / (peak + 1e-8) if peak > 0 else np.zeros_like(cam)   # no signal -> flat map, not an error
            tiles.append(tile_json(si, tile_result(slide["patches"][si], norm, peak)))
        return {"tiles": tiles}

    @modal.fastapi_endpoint(method="GET")
    def health(self):
        return {"status": "ok", "model_version": self.V.VERSION,
                "model_loaded": True, "device": self.device,
                "genes": len(self.core.genes)}
