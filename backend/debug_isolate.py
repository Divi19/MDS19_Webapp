"""
One-off isolation script for the a2 vs full_img skew.

Run on the same host/env that has MODEL_CHECKPOINT_PATH and MODEL_DATA_ROOT
set (wherever the real MclSTExpPredictor actually loads), pointed at the
exact same A2 slide image used to generate the Colab `a2` predictions.

    python debug_isolate.py /path/to/A2_full_slide.tif

It answers the brief's "first check" directly: how many tissue tiles the
backend finds, and dumps everything needed for the patch-tensor /
raw-output isolation test for the tile nearest an approximate pixel you
believe corresponds to a known Colab spot.
"""
import sys

import numpy as np

from app.core.config import settings
from app.services.predictor import MclSTExpPredictor, tissue_tile_mask
from PIL import Image, ImageOps

predictor = MclSTExpPredictor(settings.model_checkpoint_path, settings.model_data_root)
predictor.load()

path = sys.argv[1]
image = Image.open(path)
image.load()
image = ImageOps.exif_transpose(image)
print(f"image size: {image.size}")

patches, coords = predictor._tile(image)
keep = tissue_tile_mask(image, patch=predictor.PATCH, stride=predictor.STRIDE)
kept_idx = [i for i, c in enumerate(coords) if keep[c]]
print(f"raw grid tiles: {len(patches)}")
print(f"tissue-kept tiles: {len(kept_idx)}   <-- compare this to a2's 325")
print(f"first 10 kept (ix, iy): {[coords[i] for i in kept_idx[:10]]}")

# Dump one patch + its raw model output before retrieval, for the isolation test.
i = kept_idx[0]
patch = patches[i]
arr = np.array(patch.convert("RGB"), dtype=np.float32) / 255.0
print("\n--- patch tensor (spot_index 0 of kept tiles) ---")
print(f"grid coord (ix, iy): {coords[i]}")
print(f"shape: {arr.shape}, dtype: {arr.dtype}")
print(f"min/max/mean: {arr.min():.4f}/{arr.max():.4f}/{arr.mean():.4f}")

query = predictor._encode([patch])
print("\n--- raw 256-dim embedding (pre-retrieval) ---")
print(f"shape: {query.shape}")
print(f"min/max/mean: {query.min():.4f}/{query.max():.4f}/{query.mean():.4f}")

pred = predictor._retrieve(query)
print("\n--- final retrieved expression vector (785 genes) ---")
print(f"min/max/mean: {pred.min():.4f}/{pred.max():.4f}/{pred.mean():.4f}")
print("\nDump the equivalent three blocks from the Colab a2 run for the SAME")
print("physical spot and diff them in this order: patch tensor -> embedding -> final.")
