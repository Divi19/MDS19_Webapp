from contextlib import asynccontextmanager
import asyncio
import os
from pathlib import Path, PurePosixPath
import shutil
import tarfile
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router
from app.core.config import settings
from app.services.predictor import get_predictor, missing_required_artifacts

# Model data ships as one gzipped tarball rather than 98 loose files: Drive
# rate-limits on request count, and a per-file folder download reliably tripped
# that limit partway through, leaving an unusable half-populated database.
MODEL_DATA_ARCHIVE_ID = "1R69pcxfpf1kEyVqyP2noEEltVcIiWR2R"
MODEL_DATA_ROOT = "model_data"
CHECKPOINT_NAME = "best_0.pt"
EXPECTED_FILES = 98      # 97 .npy + the checkpoint


def resolve_model_artifacts(config=settings) -> tuple[str, str]:
    backend_root = Path(__file__).resolve().parents[1]
    if config.model_data_root:
        data_root = Path(config.model_data_root).expanduser()
    else:
        candidates = [
            Path.cwd() / MODEL_DATA_ROOT / "webapp_database",
            backend_root / MODEL_DATA_ROOT / "webapp_database",
        ]
        data_root = next((candidate for candidate in candidates if candidate.is_dir()), candidates[-1])
    if config.model_checkpoint_path:
        checkpoint = Path(config.model_checkpoint_path).expanduser()
    else:
        checkpoint = data_root / CHECKPOINT_NAME
    return str(data_root.resolve()), str(checkpoint.resolve())


def _model_data_complete(target_dir: str, checkpoint_path: str | None = None) -> bool:
    """A partial unpack must not look like a finished one.

    Checking only that the directory is non-empty would let a run that died
    midway be treated as cached, and predictor.load() would then fail on a
    missing .npy with nothing pointing back at the download as the cause.
    """
    if not os.path.isdir(target_dir):
        return False
    checkpoint = checkpoint_path or os.path.join(target_dir, CHECKPOINT_NAME)
    return not missing_required_artifacts(target_dir, checkpoint)


def _safe_extract_archive(archive: str, target_dir: str) -> None:
    target = Path(target_dir).resolve()
    target.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar.getmembers():
            parts = tuple(part for part in PurePosixPath(member.name).parts if part not in ("", "."))
            if not parts or parts[0] != "webapp_database" or ".." in parts or member.issym() or member.islnk():
                raise RuntimeError("Model archive contains an unsafe member")
            relative = parts[1:]
            if not relative:
                continue
            destination = target.joinpath(*relative).resolve()
            if target not in destination.parents:
                raise RuntimeError("Model archive contains an unsafe path")
            if member.isdir():
                destination.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                destination.parent.mkdir(parents=True, exist_ok=True)
                source = tar.extractfile(member)
                if source is None:
                    raise RuntimeError("Model archive contains an unreadable file")
                with source, destination.open("wb") as output:
                    shutil.copyfileobj(source, output)
            else:
                raise RuntimeError("Model archive contains an unsupported member")


def ensure_model_data(config=settings):
    """Fetch the model data on first boot. No-op once it is complete on disk."""
    if config.mode != "real":
        return
    target_dir, checkpoint_path = resolve_model_artifacts(config)
    config.model_data_root = target_dir
    config.model_checkpoint_path = checkpoint_path
    if _model_data_complete(target_dir, checkpoint_path):
        return  # already downloaded, skip

    os.makedirs(Path(target_dir).parent, exist_ok=True)
    archive = str(Path(target_dir).parent / "webapp_database.tar.gz")

    if not os.path.exists(archive) or os.path.getsize(archive) == 0:
        import gdown

        gdown.download(id=MODEL_DATA_ARCHIVE_ID, output=archive,
                       quiet=False, use_cookies=False)

    # The archive root is webapp_database/, so it unpacks straight into
    # model_data/ at the layout predictor.py expects.
    # filter= added in 3.12
    _safe_extract_archive(archive, target_dir)

    if not _model_data_complete(target_dir, checkpoint_path):
        missing = missing_required_artifacts(target_dir, checkpoint_path)
        raise RuntimeError(
            f"Model data incomplete after unpacking. Missing required artifacts: {', '.join(missing)}. "
            f"The archive at {archive} may be truncated — delete it and restart "
            f"to re-download.")

    os.remove(archive)      # ~438MB, and the unpacked copy is what gets read


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup — model data fetched before anything tries to read it.
    ensure_model_data()

    # Model loaded ONCE, not per request.
    # This is the single most important performance decision in the API.
    app.state.predictor = get_predictor(settings)
    app.state.predictor.load()
    app.state.prediction_semaphore = asyncio.BoundedSemaphore(settings.max_concurrent_predictions)
    yield
    # Shutdown
    app.state.predictor = None


app = FastAPI(title=settings.app_name, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router, prefix="/api")


@app.get("/")
async def root():
    return {"service": settings.app_name, "docs": "/docs"}