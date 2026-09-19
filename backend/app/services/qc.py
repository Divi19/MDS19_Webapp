import io
import math
import warnings

import numpy as np
from PIL import Image, UnidentifiedImageError


MAX_IMAGE_DIMENSION = 30000
MAX_IMAGE_PIXELS = 100_000_000
SUPPORTED_FORMATS = {"JPEG", "PNG", "TIFF"}


class ImageValidationError(ValueError):
    pass


def decode_image(image_bytes: bytes) -> tuple[Image.Image, str]:
    if not image_bytes:
        raise ImageValidationError("The uploaded image is empty")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            image = Image.open(io.BytesIO(image_bytes))
            image_format = (image.format or "").upper()
            width, height = image.size
            if image_format not in SUPPORTED_FORMATS:
                raise ImageValidationError("The decoded image format is not supported")
            if width < 1 or height < 1:
                raise ImageValidationError("The decoded image has invalid dimensions")
            if width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION:
                raise ImageValidationError("The decoded image dimensions exceed the supported limit")
            if width * height > MAX_IMAGE_PIXELS:
                raise ImageValidationError("The decoded image pixel count exceeds the supported limit")
            image.load()
    except ImageValidationError:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ImageValidationError("The upload is not a valid decodable image") from exc
    return image.convert("RGB"), image_format


def tissue_tile_mask(
    image: Image.Image,
    patch: int = 224,
    stride: int = 224,
    sat_thresh: float = 0.10,
    min_frac: float = 0.10,
    downsample: int = 8,
) -> dict[tuple[int, int], bool]:
    width, height = image.size
    small_width = max(1, math.ceil(width / downsample))
    small_height = max(1, math.ceil(height / downsample))
    small = image.convert("RGB").convert("HSV").resize(
        (small_width, small_height), Image.Resampling.BILINEAR
    )
    saturation = np.asarray(small, dtype=np.uint8)[:, :, 1].astype(np.float32) / 255.0
    tissue = saturation > sat_thresh
    keep = {}
    for tile_y, y in enumerate(range(0, height - patch + 1, stride)):
        for tile_x, x in enumerate(range(0, width - patch + 1, stride)):
            y0 = min(small_height, y // downsample)
            y1 = min(small_height, math.ceil((y + patch) / downsample))
            x0 = min(small_width, x // downsample)
            x1 = min(small_width, math.ceil((x + patch) / downsample))
            block = tissue[y0:y1, x0:x1]
            keep[(tile_x, tile_y)] = bool(block.size and float(block.mean()) >= min_frac)
    return keep


def _metric_array(image: Image.Image, max_side: int = 1024) -> np.ndarray:
    sample = image.convert("RGB")
    if max(sample.size) > max_side:
        sample.thumbnail((max_side, max_side), Image.Resampling.BILINEAR)
    return np.asarray(sample, dtype=np.float32) / 255.0


def build_qc_report(
    image: Image.Image,
    tile_image: Image.Image | None = None,
    patch: int = 224,
    stride: int = 224,
) -> dict:
    array = _metric_array(image)
    gray = 0.299 * array[:, :, 0] + 0.587 * array[:, :, 1] + 0.114 * array[:, :, 2]
    hsv_sample = image.convert("RGB").convert("HSV")
    if max(hsv_sample.size) > 1024:
        hsv_sample.thumbnail((1024, 1024), Image.Resampling.BILINEAR)
    saturation = np.asarray(hsv_sample, dtype=np.uint8)[:, :, 1].astype(np.float32) / 255.0
    tissue_fraction = float(np.mean(saturation > 0.10))
    brightness = float(np.mean(gray))
    contrast = float(np.std(gray))
    mean_saturation = float(np.mean(saturation))
    if gray.shape[0] >= 3 and gray.shape[1] >= 3:
        laplacian = (
            -4.0 * gray[1:-1, 1:-1]
            + gray[:-2, 1:-1]
            + gray[2:, 1:-1]
            + gray[1:-1, :-2]
            + gray[1:-1, 2:]
        )
        focus_proxy = float(np.var(laplacian))
    else:
        focus_proxy = 0.0
    tiled = image if tile_image is None else tile_image
    mask = tissue_tile_mask(tiled, patch=patch, stride=stride)
    accepted_tiles = sum(mask.values())
    rejected_tiles = len(mask) - accepted_tiles
    report_warnings = []
    if not mask:
        report_warnings.append("Image is too small to produce a prediction tile at the target scale")
    if tissue_fraction < 0.05:
        report_warnings.append("Low tissue fraction detected")
    if brightness > 0.95:
        report_warnings.append("Image is very bright")
    if contrast < 0.03:
        report_warnings.append("Image has low contrast")
    if mean_saturation < 0.05:
        report_warnings.append("Image has low mean saturation")
    if focus_proxy < 0.0001:
        report_warnings.append("Image has a low focus proxy")
    return {
        "image_width": image.width,
        "image_height": image.height,
        "tissue_fraction": tissue_fraction,
        "brightness": brightness,
        "contrast": contrast,
        "mean_saturation": mean_saturation,
        "focus_proxy": focus_proxy,
        "accepted_tile_count": accepted_tiles,
        "rejected_tile_count": rejected_tiles,
        "warnings": report_warnings,
    }
