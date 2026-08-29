from contextlib import asynccontextmanager
import os
import tarfile

import gdown
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router
from app.core.config import settings
from app.services.predictor import get_predictor

# Model data ships as one gzipped tarball rather than 98 loose files: Drive
# rate-limits on request count, and a per-file folder download reliably tripped
# that limit partway through, leaving an unusable half-populated database.
MODEL_DATA_ARCHIVE_ID = "1R69pcxfpf1kEyVqyP2noEEltVcIiWR2R"
MODEL_DATA_ROOT = "model_data"
CHECKPOINT_NAME = "best_0.pt"
EXPECTED_FILES = 98      # 97 .npy + the checkpoint


def _model_data_complete(target_dir: str) -> bool:
    """A partial unpack must not look like a finished one.

    Checking only that the directory is non-empty would let a run that died
    midway be treated as cached, and predictor.load() would then fail on a
    missing .npy with nothing pointing back at the download as the cause.
    """
    if not os.path.isdir(target_dir):
        return False
    n_files = sum(len(files) for _, _, files in os.walk(target_dir))
    return (n_files >= EXPECTED_FILES
            and os.path.exists(os.path.join(target_dir, CHECKPOINT_NAME)))


def ensure_model_data():
    """Fetch the model data on first boot. No-op once it is complete on disk."""
    target_dir = os.path.join(MODEL_DATA_ROOT, "webapp_database")
    if _model_data_complete(target_dir):
        return  # already downloaded, skip

    os.makedirs(MODEL_DATA_ROOT, exist_ok=True)
    archive = os.path.join(MODEL_DATA_ROOT, "webapp_database.tar.gz")

    if not os.path.exists(archive) or os.path.getsize(archive) == 0:
        gdown.download(id=MODEL_DATA_ARCHIVE_ID, output=archive,
                       quiet=False, use_cookies=False)

    # The archive root is webapp_database/, so it unpacks straight into
    # model_data/ at the layout predictor.py expects.
    with tarfile.open(archive, "r:gz") as tar:
        try:
            tar.extractall(MODEL_DATA_ROOT, filter="data")
        except TypeError:      # filter= added in 3.12
            tar.extractall(MODEL_DATA_ROOT)

    if not _model_data_complete(target_dir):
        n = sum(len(files) for _, _, files in os.walk(target_dir))
        raise RuntimeError(
            f"Model data incomplete after unpacking: {n}/{EXPECTED_FILES} files. "
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