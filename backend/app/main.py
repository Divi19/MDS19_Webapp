from contextlib import asynccontextmanager
import os
import tarfile

import gdown
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router
from app.core.config import settings
from app.services.predictor import get_predictor

# Model data ships as one gzipped tarball rather than N loose files: Drive
# rate-limits on request count, and a per-file folder download reliably tripped
# that limit partway through, leaving an unusable half-populated database.
#
# EXPECTED_FILES is a MINIMUM, not an exact count: 32 sections x
# (spot_embeddings_i.npy + preprocessed_matrix.npy) + her_hvg_cut_1000.npy +
# the checkpoint = 66. That is what scripts/build_tau020_bank.py's own
# assembled-bank check already verifies at build time (section-by-section
# spot counts, no NaNs, correct total shape) for every bank it produces,
# v7 included. A bank built some other way may legitimately have more files
# (n_files >= EXPECTED_FILES still passes) — just never fewer.
EXPECTED_FILES = 66


def _model_data_complete(target_dir: str, checkpoint_path: str) -> bool:
    """A partial unpack must not look like a finished one.

    Checking only that the directory is non-empty would let a run that died
    midway be treated as cached, and predictor.load() would then fail on a
    missing .npy with nothing pointing back at the download as the cause.
    """
    if not os.path.isdir(target_dir):
        return False
    n_files = sum(len(files) for _, _, files in os.walk(target_dir))
    return n_files >= EXPECTED_FILES and os.path.exists(checkpoint_path)


def ensure_model_data():
    """
    Fetch the model data on first boot. No-op once it is complete on disk.

    target_dir is settings.model_data_root itself — NOT a hardcoded
    "model_data/webapp_database" — so switching which bank gets deployed
    (e.g. baseline -> v7) is purely MODEL_DATA_ARCHIVE_ID + MODEL_DATA_ROOT +
    MODEL_CHECKPOINT_PATH changing together on the host, no code change.

    The tarball's own top-level folder name MUST equal
    os.path.basename(model_data_root) (e.g. "webapp_database_v7" for a v7
    deploy) — extracting into the parent directory is what produces
    target_dir, so a mismatched folder name inside the archive silently
    leaves target_dir missing even though the download "succeeded".
    """
    target_dir = settings.model_data_root
    if _model_data_complete(target_dir, settings.model_checkpoint_path):
        return  # already downloaded, skip

    parent_dir = os.path.dirname(target_dir) or "."
    os.makedirs(parent_dir, exist_ok=True)
    archive = os.path.join(parent_dir, os.path.basename(target_dir) + ".tar.gz")

    if not os.path.exists(archive) or os.path.getsize(archive) == 0:
        gdown.download(id=settings.model_data_archive_id, output=archive,
                       quiet=False, use_cookies=False)

    with tarfile.open(archive, "r:gz") as tar:
        try:
            tar.extractall(parent_dir, filter="data")
        except TypeError:      # filter= added in 3.12
            tar.extractall(parent_dir)

    if not _model_data_complete(target_dir, settings.model_checkpoint_path):
        n = (sum(len(files) for _, _, files in os.walk(target_dir))
             if os.path.isdir(target_dir) else 0)
        raise RuntimeError(
            f"Model data incomplete after unpacking: {n}/{EXPECTED_FILES} files, "
            f"checkpoint present: {os.path.exists(settings.model_checkpoint_path)}. "
            f"The archive at {archive} may be truncated, or its top-level "
            f"folder name doesn't match {os.path.basename(target_dir)!r} — "
            f"delete it and restart to re-download.")

    os.remove(archive)      # the unpacked copy is what gets read


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup — model data fetched before anything tries to read it.
    ensure_model_data()

    # Model loaded ONCE, not per request.
    # This is the single most important performance decision in the API.
    app.state.predictor = get_predictor(settings)
    app.state.predictor.load()
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
