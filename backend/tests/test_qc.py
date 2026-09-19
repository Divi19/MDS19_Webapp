import io

import pytest
from PIL import Image

from app.services.qc import ImageValidationError, build_qc_report, decode_image


def _image_bytes(color, size=(224, 224), image_format="PNG"):
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format=image_format)
    return buffer.getvalue()


def test_qc_is_deterministic_and_reports_tissue_tiles():
    image, image_format = decode_image(_image_bytes((160, 40, 120)))
    first = build_qc_report(image)
    second = build_qc_report(image)
    assert image_format == "PNG"
    assert first == second
    assert first["image_width"] == 224
    assert first["image_height"] == 224
    assert first["accepted_tile_count"] == 1
    assert first["rejected_tile_count"] == 0
    assert first["tissue_fraction"] == pytest.approx(1.0)
    assert set(first) == {
        "image_width",
        "image_height",
        "tissue_fraction",
        "brightness",
        "contrast",
        "mean_saturation",
        "focus_proxy",
        "accepted_tile_count",
        "rejected_tile_count",
        "warnings",
    }


def test_qc_rejects_blank_tiles_and_emits_warnings():
    image, _ = decode_image(_image_bytes((255, 255, 255)))
    report = build_qc_report(image)
    assert report["accepted_tile_count"] == 0
    assert report["rejected_tile_count"] == 1
    assert "Low tissue fraction detected" in report["warnings"]
    assert "Image has low contrast" in report["warnings"]


def test_decode_rejects_non_image_data():
    with pytest.raises(ImageValidationError, match="valid decodable image"):
        decode_image(b"not an image")
