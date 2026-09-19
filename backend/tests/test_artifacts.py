import io
from pathlib import Path
import tarfile
from types import SimpleNamespace

import pytest

from app import main
from app.main import _model_data_complete, _safe_extract_archive, ensure_model_data, resolve_model_artifacts
from app.services.predictor import required_artifact_paths


def test_artifact_resolution_preserves_overrides(tmp_path):
    data_root = tmp_path / "custom_database"
    checkpoint = tmp_path / "custom_checkpoint.pt"
    config = SimpleNamespace(
        mode="real",
        model_data_root=str(data_root),
        model_checkpoint_path=str(checkpoint),
    )
    resolved_root, resolved_checkpoint = resolve_model_artifacts(config)
    assert resolved_root == str(data_root.resolve())
    assert resolved_checkpoint == str(checkpoint.resolve())


def test_artifact_resolution_uses_backend_model_data_by_default(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    config = SimpleNamespace(
        mode="real",
        model_data_root="",
        model_checkpoint_path="",
    )
    resolved_root, resolved_checkpoint = resolve_model_artifacts(config)
    expected_root = Path(main.__file__).resolve().parents[1] / "model_data" / "webapp_database"
    assert resolved_root == str(expected_root)
    assert resolved_checkpoint == str(expected_root / "best_0.pt")


def test_artifact_resolution_finds_checkpoint_inside_database(tmp_path):
    data_root = tmp_path / "database"
    config = SimpleNamespace(
        mode="real",
        model_data_root=str(data_root),
        model_checkpoint_path="",
    )
    _, resolved_checkpoint = resolve_model_artifacts(config)
    assert resolved_checkpoint == str((data_root / "best_0.pt").resolve())


def test_completeness_checks_every_required_predictor_file(tmp_path):
    data_root = tmp_path / "webapp_database"
    checkpoint = data_root / "best_0.pt"
    paths = required_artifact_paths(data_root, checkpoint)
    assert len(paths) == 66
    for path in paths:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"x")
    assert _model_data_complete(str(data_root), str(checkpoint))
    missing_path = data_root / "spot_embeddings_17.npy"
    missing_path.unlink()
    assert not _model_data_complete(str(data_root), str(checkpoint))


def test_safe_extraction_rejects_path_traversal(tmp_path):
    archive = tmp_path / "unsafe.tar.gz"
    payload = b"unsafe"
    with tarfile.open(archive, "w:gz") as tar:
        member = tarfile.TarInfo("webapp_database/../../escaped")
        member.size = len(payload)
        tar.addfile(member, io.BytesIO(payload))
    with pytest.raises(RuntimeError, match="unsafe"):
        _safe_extract_archive(str(archive), str(tmp_path / "target"))
    assert not (tmp_path / "escaped").exists()


def test_demo_startup_never_downloads_artifacts(tmp_path):
    config = SimpleNamespace(
        mode="demo",
        model_data_root=str(tmp_path / "missing"),
        model_checkpoint_path="",
    )
    ensure_model_data(config)
    assert not Path(config.model_data_root).exists()
