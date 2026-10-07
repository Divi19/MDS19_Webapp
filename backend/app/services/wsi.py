"""
Whole-slide image (WSI) support.

Real pathology scanners export multi-resolution pyramidal formats (.svs,
.ndpi, .scn, .vms, .vmu, .svslide) or, for 3DHistech scanners, a `.mrxs`
index file alongside a sibling data folder -- none of which PIL can open.
This module converts any of those into a plain RGB image (PNG bytes) at a
bounded resolution, so everything downstream (routes.py, predictor.py,
Modal's infer.py) keeps seeing exactly what it already expects: a normal
image file. No other part of the pipeline needs to know a WSI was ever
involved.

Requires the native OpenSlide library (apt: openslide-tools) -- see
backend/Dockerfile. openslide-python is a thin ctypes wrapper around it,
not a pure-Python implementation, so this will ImportError/OSError on a
host that only installed the pip package.
"""
import io
import tempfile
import zipfile
from pathlib import Path

import openslide
from PIL import Image

# Single-file pyramidal formats OpenSlide reads directly. .mrxs is
# deliberately NOT here -- it needs the zip path below, since the .mrxs
# file by itself (without its sibling data folder) cannot be opened.
WSI_EXTENSIONS = {".svs", ".ndpi", ".scn", ".vms", ".vmu", ".svslide", ".bif"}

# .mrxs ships as an index file plus a same-named folder of tile data
# (e.g. slide.mrxs + slide/). A browser upload can only carry one file, so
# a .mrxs slide must be zipped (file + folder together) before upload.
MRXS_VIA_ZIP = ".zip"

# Hard ceiling on the converted image's longer side. The existing pipeline
# tiles at 224px with MAX_PATCHES=600 tissue tiles (routes.py/predictor.py),
# so handing it a multi-gigapixel region would just get rejected one step
# later with a less useful error. 4096px keeps well within that budget
# while still giving a meaningfully detailed region -- raise it only
# alongside MAX_PATCHES, not independently.
DEFAULT_MAX_DIMENSION = 4096


def is_wsi_filename(filename: str | None) -> bool:
    """True if this upload needs OpenSlide rather than PIL."""
    if not filename:
        return False
    suffix = Path(filename).suffix.lower()
    if suffix == MRXS_VIA_ZIP:
        # Only a .mrxs bundle is expected as a zip here -- a zip of a plain
        # jpg/png would be a user error, and convert_wsi_to_image_bytes()
        # raises a clear ValueError for that case rather than guessing.
        return True
    return suffix in WSI_EXTENSIONS


def _best_level_for(slide: "openslide.OpenSlide", max_dimension: int) -> int:
    """Highest-resolution level whose longer side still fits max_dimension.

    Falls back to the lowest-resolution level (level_count - 1) if even
    that is still too big -- better a capped-but-working image than an
    OOM from reading a full-resolution level by mistake.
    """
    for level in range(slide.level_count):
        w, h = slide.level_dimensions[level]
        if max(w, h) <= max_dimension:
            return level
    return slide.level_count - 1


def _open_and_render(path: Path, max_dimension: int) -> Image.Image:
    with openslide.OpenSlide(str(path)) as slide:
        level = _best_level_for(slide, max_dimension)
        w, h = slide.level_dimensions[level]
        # read_region's origin is always in level-0 coordinates, but (0, 0)
        # is level-0's origin regardless of which level you then read at,
        # so no scaling is needed here.
        region = slide.read_region((0, 0), level, (w, h))

    # OpenSlide returns RGBA; background outside the scanned area is fully
    # transparent, not white, so compositing onto a flat white background
    # (rather than Image.convert("RGB"), which would just drop the alpha
    # and leave scanner-black) matches what a real H&E slide's glass
    # background looks like -- and matches what the tissue mask's
    # saturation threshold already assumes (see predictor.tissue_tile_mask).
    background = Image.new("RGB", region.size, (255, 255, 255))
    background.paste(region, mask=region.split()[3])
    return background


def convert_wsi_to_image_bytes(data: bytes, filename: str,
                                max_dimension: int = DEFAULT_MAX_DIMENSION) -> bytes:
    """
    WSI bytes (.svs/.ndpi/.../.mrxs-as-zip) -> PNG bytes, ready for the
    exact same Image.open(io.BytesIO(...)) call predictor.py and Modal's
    infer.py already use for a normal upload.

    OpenSlide needs a real file path (and, for .mrxs, the sibling data
    folder sitting next to it on disk) -- it cannot open from an in-memory
    buffer -- so this always round-trips through a temp directory, cleaned
    up before returning either way.
    """
    suffix = Path(filename).suffix.lower()

    with tempfile.TemporaryDirectory(prefix="wsi-upload-") as tmpdir:
        tmp = Path(tmpdir)

        if suffix == MRXS_VIA_ZIP:
            zip_path = tmp / "upload.zip"
            zip_path.write_bytes(data)
            with zipfile.ZipFile(zip_path) as zf:
                zf.extractall(tmp)
            mrxs_files = list(tmp.rglob("*.mrxs"))
            if not mrxs_files:
                raise ValueError(
                    "Zip upload contains no .mrxs file -- a .mrxs slide "
                    "must be zipped together with its sibling data folder "
                    "(the folder with the same name as the .mrxs file)")
            slide_path = mrxs_files[0]
        elif suffix in WSI_EXTENSIONS:
            slide_path = tmp / f"upload{suffix}"
            slide_path.write_bytes(data)
        else:
            raise ValueError(
                f"{filename!r} is not a recognised whole-slide format "
                f"(expected one of {sorted(WSI_EXTENSIONS)} or a .zip "
                f"containing a .mrxs bundle)")

        try:
            image = _open_and_render(slide_path, max_dimension)
        except openslide.OpenSlideError as exc:
            raise ValueError(
                f"Could not open {filename!r} as a whole-slide image: {exc}"
            ) from exc

        buf = io.BytesIO()
        image.save(buf, format="PNG")
        return buf.getvalue()
