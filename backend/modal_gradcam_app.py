"""
Grad-CAM for v16-core, served from a Modal T4 GPU.   (multi-cancer version)

    MULTICANCER=off (default)   the current service: HER2ST breast model, 290 px grid, same behaviour as before
    MULTICANCER=on              the slide is routed exactly as predict does (or the request's `tissue` is used), and
                                the explained model, grid spacing and spot order are that cancer's

The flag is read at deploy time and baked into the image. Deploy from the backend/ folder (it needs backend/app/),
with mc_pipeline.py next to this file:

    # staging (new URLs, the live Grad-CAM untouched)
    MDS19_GRADCAM_APP_NAME=mds19-multicancer-gradcam-test MULTICANCER=on \
        MDS19_MODAL_VOLUME=mds19-model-data MDS19_HF_SECRET=huggingface-secret modal deploy modal_gradcam_app.py
    # production
    MULTICANCER=on MDS19_MODAL_VOLUME=mds19-model-data MDS19_HF_SECRET=huggingface-secret modal deploy modal_gradcam_app.py
    # rollback: the same command without MULTICANCER=on (or redeploy the previous file)

Why a slide used to fail for non-breast cancers: this app tiled every slide at 290 px, but the 100 um cancer models
predict on a 145 px grid, so spot_index N pointed at a different tile (or past the end). Now the tiles come from
mc_pipeline.Pipeline.plan(), the SAME code predict uses, so `spot_index` is the same tile in both services.

Endpoint: POST {"image_url", "spot_indices": [...], "gene": "ERBB2"|null, "tissue": "COAD"|null}
      ->  {"tiles": [{"spot_index", "png_base64", "peak", "heat", "mask", "heat_size"}, ...],
           "tissue": "COAD", "model": "COAD", "stride_px": 145}            (the last three only with the flag on)
`tissue` is the router class the predict response reported (tissue.code), or the user's override. If it is missing the
slide is routed again, which gives the same answer as predict unless the user had overridden it.
Explains the REGRESSOR half only (the retrieval half has no network to differentiate).
"""
import io
import os
from pathlib import Path

import modal
from PIL import Image, ImageOps

VOLUME_NAME = os.environ.get("MDS19_MODAL_VOLUME", "mds19-model-data")
HF_SECRET = os.environ.get("MDS19_HF_SECRET", "huggingface-secret")
APP_NAME = os.environ.get("MDS19_GRADCAM_APP_NAME", "mds19-v7-gradcam")   # name kept: Render's URLs do not change
MULTICANCER = os.environ.get("MULTICANCER", "off").strip().lower() in ("on", "1", "true", "yes")
DATA_DIR = "/data"
V16_DIR = f"{DATA_DIR}/v16core_production"
MC_DIR = f"{DATA_DIR}/multicancer"

HERE = Path(__file__).parent

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libgl1", "libglib2.0-0")
    .pip_install(
        "torch", "torchvision", "timm", "einops", "scipy", "numpy", "pillow",
        "requests", "huggingface_hub", "fastapi[standard]",
    )
    .env({"MULTICANCER": "on" if MULTICANCER else "off"})
    .add_local_file(HERE / "mc_pipeline.py", remote_path="/root/mc_pipeline.py")
    .add_local_dir(HERE / "app", remote_path="/root/app",
                   ignore=["**/__pycache__", "**/*.pyc", "main.py", "api/**"])
)

app = modal.App(APP_NAME)
volume = modal.Volume.from_name(VOLUME_NAME)

H0MINI_MEAN = (0.707223, 0.578729, 0.703617)
H0MINI_STD = (0.211883, 0.230117, 0.177517)
H0MINI_NUM_PREFIX_TOKENS = 5
H0MINI_REPO = "hf-hub:bioptimus/H0-mini"

MAX_TISSUE_TILES = 4000        # 200 um grid (breast, and what the router sees)
MAX_TISSUE_TILES_FINE = int(os.environ.get("MAX_TISSUE_TILES_FINE", "6000"))   # 100 um grid: keep equal to predict's


@app.cls(
    gpu="T4",
    image=image,
    volumes={DATA_DIR: volume},
    secrets=[modal.Secret.from_name(HF_SECRET)],
    timeout=900,
    # One warm container keeps the slide's features cached between the many batch requests a whole-slide mosaic makes.
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

        from mc_pipeline import Pipeline
        self.multicancer = MULTICANCER
        if self.multicancer:
            sys.path.insert(0, MC_DIR)
            import multicancer_inference as MC
            self.V = MC
            self.mc = MC.MultiCancer(MC_DIR)                     # a cancer's model loads on its first slide
            self.core = self.mc.model("her2st")                  # breast, preloaded like predict does
        else:
            sys.path.insert(0, V16_DIR)
            import v16core_inference as V
            self.V = V
            self.mc = None
            self.core = V.V16Core(V16_DIR, device=self.device)
        self.pipeline = Pipeline(self.mc, self._encode, None, None,
                                 max_tiles_coarse=MAX_TISSUE_TILES,
                                 max_tiles_fine=MAX_TISSUE_TILES_FINE) if self.multicancer else None
        self._freeze(self.core)
        self.slide = None          # one-slot cache, keyed by (URL path, tissue)
        print(f"gradcam loaded {self.V.VERSION}: multicancer={self.multicancer}, "
              f"{len(self.core.genes)} breast genes, device={self.device}")

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

    @staticmethod
    def _freeze(core):
        """only the crop pixels need gradients, not the model's weights (also for cancer models loaded later)"""
        for p in core.reg.parameters():
            p.requires_grad_(False)

    def _slide_inputs(self, grid, core):
        """positional code + neighbour table. The 100 um models need their grid unit passed in (it defaults to 200)."""
        if self.multicancer:
            return self.V.slide_inputs(grid, core.rc, self.device, core.unit)
        return self.V.slide_inputs(grid, core.rc, self.device)

    def _load_slide(self, url: str, tissue):
        """Download the slide, then build it (cached for the next batches)."""
        import requests

        key = (url.split("?", 1)[0], tissue or None)   # the signed query string changes, the path does not
        if self.slide is not None and self.slide["key"] == key:
            return self.slide
        resp = requests.get(url, timeout=120)
        resp.raise_for_status()
        return self._build_slide(key, resp.content, tissue)

    def _build_slide(self, key, content: bytes, tissue):
        """Route + tile + encode the whole slide once."""
        import numpy as np
        import torch
        from mc_pipeline import FeatureExtractor, STRIDE_BY_UNIT

        img = Image.open(io.BytesIO(content))
        img.load()
        img = ImageOps.exif_transpose(img)            # same orientation handling as predict

        if self.multicancer:
            plan = self.pipeline.plan(img, tissue)    # same routing + tiling code as predict
            if plan.unsupported is not None:
                raise ValueError(plan.unsupported["message"])
            core, stride, tiles, model_key = plan.core, plan.stride, plan.tiles, plan.model_key
            tissue_code = plan.code
        else:
            core, stride, model_key, tissue_code = self.core, STRIDE_BY_UNIT[200], "her2st", None
            tiles = FeatureExtractor(img, self._encode).tiles(stride, MAX_TISSUE_TILES)

        self._freeze(core)
        grid = np.asarray(tiles.coords, dtype=np.int64)
        pe, nb = self._slide_inputs(grid, core)
        slide = dict(key=key, img=img, core=core, stride=stride, coords=list(tiles.coords), grid=grid,
                     model_key=model_key, tissue=tissue_code,
                     h0=tiles.native, w672=tiles.context,
                     XT=core._x(tiles.native), XC=core._x(tiles.context), pe=pe, nb=nb, top_gene=None)

        # slide's top predicted gene (fallback when the caller sends no gene)
        pred = core.predict(tiles.native, tiles.context, grid)
        slide["top_gene"] = core.genes[int(np.argmax(pred.mean(axis=0)))]
        self.slide = slide
        return slide

    def _cam_one(self, slide, i: int, gi: int):
        """Grad-CAM of the regressor's prediction of gene gi at spot i, on the SPOT crop.
        Returns (raw 16x16 cam, peak). Same method as multicancer_inference.gradcam_regressor
        but the raw peak is kept (that function normalises it away) and the slide-level
        tensors are reused instead of rebuilt per spot."""
        import numpy as np
        import torch
        import torch.nn.functional as F
        from mc_pipeline import crop_context, crop_tile

        core = slide["core"]
        ix, iy = slide["coords"][i]
        spot = crop_tile(slide["img"], ix, iy, slide["stride"])
        ctx = crop_context(slide["img"], ix, iy, slide["stride"])

        enc = self.h0mini
        npre = H0MINI_NUM_PREFIX_TOKENS
        store = {}
        hk = enc.blocks[-1].register_forward_hook(lambda m, inp, out: store.__setitem__("a", out))
        try:
            with torch.enable_grad():
                crops = [np.asarray(spot.convert("RGB"), dtype=np.float32),
                         np.asarray(ctx.convert("RGB"), dtype=np.float32)]
                x = torch.from_numpy(np.stack(crops)).permute(0, 3, 1, 2).to(self.device) / 255.0
                x = ((x - self.mean) / self.std).requires_grad_(True)
                tok = enc.forward_features(x).float()
                a = store["a"]
                a.retain_grad()
                feat = torch.cat([tok[:, 0], tok[:, npre:].mean(1)], 1)
                XT, XC = slide["XT"], slide["XC"]
                XT = torch.cat([XT[:i], feat[0:1], XT[i + 1:]])
                XC = torch.cat([XC[:i], feat[1:2], XC[i + 1:]])
                out = core.reg(XT, XC, slide["pe"], slide["nb"])[0][i, gi]
                out.backward()
        finally:
            hk.remove()
        A = a.detach()[:, npre:].float()
        G = a.grad[:, npre:].float()
        cam = F.relu((A * G.mean(1, keepdim=True)).sum(-1))[0]      # spot crop only, (256,)
        side = int(round(cam.shape[0] ** 0.5))
        cam = cam.reshape(side, side).cpu().numpy()
        return cam, float(cam.max()), spot

    # ------------------------------------------------------------------
    def _explain(self, slide, indices, gene):
        import numpy as np
        from fastapi import HTTPException

        from app.services.gradcam import tile_json, tile_result

        n = len(slide["coords"])
        for si in indices:
            if not (0 <= int(si) < n):
                raise HTTPException(
                    status_code=400,
                    detail=f"spot_index {si} out of range — this image has {n} tissue tiles (0..{n - 1})")

        core = slide["core"]
        if gene is None:
            gene = slide["top_gene"]
        if gene not in core.genes:
            raise HTTPException(status_code=400, detail=f"Unknown gene {gene!r} for model {slide['model_key']}")
        gi = core.genes.index(gene)

        tiles = []
        for si in indices:
            si = int(si)
            cam, peak, spot = self._cam_one(slide, si, gi)
            norm = cam / (peak + 1e-8) if peak > 0 else np.zeros_like(cam)   # no signal -> flat map, not an error
            tiles.append(tile_json(si, tile_result(spot, norm, peak)))
        out = {"tiles": tiles}
        if self.multicancer:
            out.update({"tissue": slide["tissue"], "model": slide["model_key"], "stride_px": slide["stride"]})
        return out

    @modal.fastapi_endpoint(method="POST")
    def explain_batch(self, item: dict):
        from fastapi import HTTPException

        url = item.get("image_url")
        indices = item.get("spot_indices") or []
        gene = item.get("gene") or None
        tissue = item.get("tissue") or None
        if not url or not indices:
            raise HTTPException(status_code=400, detail="image_url and spot_indices are required")
        if tissue and not self.multicancer:
            tissue = None                                # flag off: breast only, the field is ignored

        try:
            slide = self._load_slide(url, tissue)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        return self._explain(slide, [int(i) for i in indices], gene)

    @modal.method()
    def smoke(self, image_bytes: bytes, tissue: str = "", n: int = 8, gene: str = ""):
        """Staging check from `modal run`: builds the slide from local bytes (no public URL needed), explains n
        spots spread across it and reports what the service sees plus timings. Returns a small summary."""
        import time

        tissue = (tissue or None) if self.multicancer else None
        t0 = time.time()
        slide = self._build_slide(("smoke", tissue), image_bytes, tissue)
        t_load = time.time() - t0
        total = len(slide["coords"])
        picks = sorted({int(round(k * (total - 1) / max(n - 1, 1))) for k in range(n)})
        t1 = time.time()
        out = self._explain(slide, picks, gene or None)
        per_spot = (time.time() - t1) / len(picks)
        peaks = [round(t["peak"], 5) for t in out["tiles"]]
        return {"n_tiles": total, "stride_px": slide["stride"], "tissue": slide["tissue"],
                "model": slide["model_key"], "gene": gene or slide["top_gene"], "spots_tested": picks,
                "peaks": peaks, "all_peaks_zero": all(p == 0 for p in peaks),
                "load_seconds": round(t_load, 1), "seconds_per_spot": round(per_spot, 2),
                "est_full_mosaic_minutes": round(per_spot * total / 60, 1)}

    @modal.fastapi_endpoint(method="GET")
    def health(self):
        info = {"status": "ok", "model_version": self.V.VERSION, "model_loaded": True, "device": self.device,
                "genes": len(self.core.genes), "multicancer": self.multicancer}
        if self.multicancer:
            info["routes"] = self.mc.reg["route"]
        return info


@app.local_entrypoint()
def smoke(image_path: str, tissue: str = "", n: int = 8, gene: str = ""):
    """modal run modal_gradcam_app.py::smoke --image-path /content/slides_sizes/COAD_5000px.jpg [--tissue COAD]"""
    with open(image_path, "rb") as f:
        data = f.read()
    res = V7GradCam().smoke.remote(data, tissue, n, gene)
    for k, v in res.items():
        print(f"{k}: {v}")
