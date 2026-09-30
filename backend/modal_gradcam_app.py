"""
Grad-CAM for the v7 (H0-mini dual-crop) model, served from a Modal T4 GPU.

Deploy (from the backend/ folder, needs the `modal` CLI logged in to the
workspace that owns the v7 volume):

    modal deploy modal_gradcam_app.py

This is a SEPARATE Modal app from mds19-v7-inference (the predict endpoint),
so deploying or breaking one cannot affect the other. It reuses this repo's
own pipeline — app/services/predictor.py's MclSTExpPredictor with
encoder_backend="h0mini" — rather than a second copy of the tiling / crops /
normalisation / retrieval code, which is what guarantees `spot_index` here
means exactly what it means in the predict endpoint's "spots" list.

What has to match the deployed predict service (defaults below are guesses;
override with env vars at deploy time if they differ):
  MDS19_MODAL_VOLUME      name of the Modal Volume holding the v7 checkpoint
                          and reference bank            (default mds19-v7-data)
  MDS19_MODEL_DATA_ROOT   bank folder INSIDE that volume, as mounted at /data
                                              (default /data/webapp_database_v7_2)
  MDS19_MODEL_CHECKPOINT  v7 checkpoint path inside the volume
                                      (default /data/webapp_database_v7_2/best_0.pt)
  MDS19_HF_SECRET         Modal Secret providing HF_TOKEN, needed to download
                          the gated bioptimus/H0-mini weights (default hf-token)
The bank must be the v7 one — encoder and bank from different pipelines
match without any error and give garbage (see encoders.py).

Endpoint: POST {"image_url", "spot_indices": [...], "gene": "ERBB2"|null}
      ->  {"tiles": [{"spot_index", "png_base64", "peak"}, ...]}
Same shape as the Render API's /api/predict/gradcam/batch response.
"""
import os
from pathlib import Path

import modal

VOLUME_NAME = os.environ.get("MDS19_MODAL_VOLUME", "mds19-v7-data")
DATA_ROOT = os.environ.get("MDS19_MODEL_DATA_ROOT", "/data/webapp_database_v7_2")
CHECKPOINT = os.environ.get("MDS19_MODEL_CHECKPOINT", "/data/webapp_database_v7_2/best_0.pt")
HF_SECRET = os.environ.get("MDS19_HF_SECRET", "hf-token")

HERE = Path(__file__).parent

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libgl1", "libglib2.0-0")
    .pip_install(
        "torch", "torchvision", "timm", "einops", "numpy", "pillow",
        "requests", "huggingface_hub", "fastapi[standard]",
    )
    .add_local_dir(HERE / "app", remote_path="/root/app",
                   ignore=["**/__pycache__", "**/*.pyc", "main.py", "api/**"])
)

app = modal.App("mds19-v7-gradcam")
volume = modal.Volume.from_name(VOLUME_NAME)


@app.cls(
    gpu="T4",
    image=image,
    volumes={"/data": volume},
    secrets=[modal.Secret.from_name(HF_SECRET)],
    timeout=600,
    # One warm container keeps the slide's tiles cached between the ~33
    # consecutive batch requests a 525-spot mosaic makes; a second container
    # would re-download and re-tile the whole slide from scratch.
    max_containers=1,
    scaledown_window=300,
)
class V7GradCam:
    @modal.enter()
    def load(self):
        import torch
        from app.services.predictor import MclSTExpPredictor

        self.predictor = MclSTExpPredictor(
            CHECKPOINT, DATA_ROOT,
            encoder_backend="h0mini",
            device="cuda" if torch.cuda.is_available() else "cpu",
        )
        self.predictor.load()
        self._bytes_key = None
        self._bytes = None

    def _slide_bytes(self, url: str) -> bytes:
        """Download the slide once per staged object. The signed URL's query
        string changes when it is re-signed; its path does not."""
        import requests

        key = url.split("?", 1)[0]
        if self._bytes_key != key:
            resp = requests.get(url, timeout=120)
            resp.raise_for_status()
            self._bytes, self._bytes_key = resp.content, key
        return self._bytes

    @modal.fastapi_endpoint(method="POST")
    def explain_batch(self, item: dict):
        import base64

        from fastapi import HTTPException

        url = item.get("image_url")
        indices = item.get("spot_indices") or []
        gene = item.get("gene") or None
        if not url or not indices:
            raise HTTPException(status_code=400, detail="image_url and spot_indices are required")

        try:
            results = self.predictor.explain_batch(self._slide_bytes(url), [int(i) for i in indices], gene)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

        return {"tiles": [
            {"spot_index": i, "png_base64": base64.b64encode(png).decode("ascii"), "peak": peak}
            for i, (png, peak) in zip(indices, results)
        ]}

    @modal.fastapi_endpoint(method="GET")
    def health(self):
        return {"status": "ok", "model_loaded": self.predictor.is_loaded,
                "device": self.predictor.device}
