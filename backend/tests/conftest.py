"""Shared test fixtures.

The tissue classifier weights and acceptance inputs are model artifacts, so
they live in backend/model_data/tissue_clf_v1/ (gitignored, like the
expression reference bank) rather than in git. Tests that need them skip
with a clear reason when the folder is absent.
"""
import sys
from pathlib import Path

import pytest

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

TISSUE_STAGE_DIR = BACKEND_ROOT / "model_data" / "tissue_clf_v1"


@pytest.fixture(scope="session")
def tissue_stage_dir() -> Path:
    required = ("stage_config.json", "tissue_clf.npz")
    if not all((TISSUE_STAGE_DIR / name).is_file() for name in required):
        pytest.skip(f"tissue classifier artifacts not found in {TISSUE_STAGE_DIR}")
    return TISSUE_STAGE_DIR


@pytest.fixture(scope="session")
def acceptance_b1(tissue_stage_dir):
    import numpy as np

    path = tissue_stage_dir / "acceptance_B1.npz"
    if not path.is_file():
        pytest.skip(f"{path} not found")
    z = np.load(path)
    return {k: z[k] for k in z.files}
