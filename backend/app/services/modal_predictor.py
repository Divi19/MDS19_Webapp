"""
Relays prediction requests to the Modal-hosted v7 (H0-mini dual-crop) GPU
service instead of running inference in-process on Render.

Why this exists: Render has no GPU tier at any plan, and v7's H0-mini
encoder does two full ViT forward passes per tissue tile (~86M params) vs
the old DenseNet121 baseline's single pass (~8M params) — on a single
shared vCPU that made real requests take ~4 minutes. The fix keeps
Render hosting the website/API/Supabase unchanged and moves only the
model's forward pass to a Modal T4 GPU (see MDS19_Modal_Handover.md and
MDS19_Inference_Speed_Fix.md for the full history).

The Modal endpoint (infer.py, already deployed) takes {"image_url": ...} —
a link, not raw bytes, since slides are large. This predictor stages each
upload as a short-lived Supabase Storage object to get that URL, calls
Modal, then deletes the object — the object is a transient relay, not a
copy of the user's slide (the frontend already persists the real upload to
the private `he-images` bucket for prediction history; this predictor never
touches that bucket).

Grad-CAM (explain()/explain_batch()) relays to a second Modal endpoint,
backend/modal_gradcam_app.py, which runs the same MclSTExpPredictor
h0mini pipeline on a GPU. The whole-slide mosaic calls it once per batch of
spots, so the slide is staged in the relay bucket ONCE and reused across
batches (see _stage_for_gradcam) instead of being re-uploaded every call.
"""

from __future__ import annotations

import hashlib
import logging
import threading
import uuid

import httpx
from supabase import create_client, Client

logger = logging.getLogger(__name__)

# Only need BasePredictor's contract; importing the whole predictor module
# would pull in torch/mclstexp for a class that uses neither.
from app.services.gradcam import TileResult, tile_from_json
from app.services.predictor import BasePredictor


class ModalPredictor(BasePredictor):
    """
    Contract-identical drop-in for MclSTExpPredictor: same predict() input
    (raw image bytes) and output shape (spots / top_genes / model_version).
    Everything else about the app — routes, schemas, frontend — is
    unaffected by which predictor is behind app.state.predictor.
    """

    # Modal cold starts (container idle -> new one spinning up) can take
    # 30-60s per the handover doc; warm calls are ~10-20s. Generous enough
    # to cover a cold start plus a large slide's inference, not so long that
    # a genuinely dead endpoint hangs the request forever.
    DEFAULT_TIMEOUT_SECONDS = 150.0

    # How long the staged upload's signed URL stays valid. Only needs to
    # outlive one Modal request (upload -> Modal's own requests.get ->
    # inference); the object is deleted right after regardless.
    SIGNED_URL_TTL_SECONDS = 600

    def __init__(
        self,
        predict_url: str,
        health_url: str,
        supabase_url: str,
        supabase_service_role_key: str,
        relay_bucket: str = "model-relay",
        request_timeout: float = DEFAULT_TIMEOUT_SECONDS,
        gradcam_url: str = "",
    ):
        if not predict_url:
            raise ValueError("MODAL_PREDICT_URL is required when USE_MODAL_INFERENCE=true")
        if not supabase_url or not supabase_service_role_key:
            raise ValueError(
                "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required when "
                "USE_MODAL_INFERENCE=true — the relay upload needs a "
                "service-role client to bypass the he-images-style per-user "
                "RLS policies (this predictor's uploads belong to no single "
                "auth.uid(), so the anon key can't write them)."
            )

        self.predict_url = predict_url
        self.health_url = health_url
        self.relay_bucket = relay_bucket
        self.gradcam_url = gradcam_url
        self.request_timeout = request_timeout

        self._supabase: Client = create_client(supabase_url, supabase_service_role_key)
        self._http = httpx.Client(timeout=request_timeout)
        self._loaded = False
        # Slide currently staged for Grad-CAM batches: {"key", "path", "url",
        # "url_expires"}. One slot — the mosaic works on one slide at a time.
        self._gradcam_stage: dict | None = None
        self._gradcam_timer: threading.Timer | None = None
        self._stage_lock = threading.Lock()
        # Reported model_version if a request somehow returns a payload
        # without one — should never trigger against the real endpoint,
        # it's just so predict() never returns a blank string.
        self._fallback_model_version = "mclstexp-her2st-v7-h0mini-modal-t4"

    def load(self) -> None:
        """
        Called once at app startup. Deliberately does NOT hard-fail Render's
        boot if Modal is unreachable right now — a cold/scaled-to-zero Modal
        app can take a while to answer a health check, and the first real
        /api/predict call will surface a clear error if it's genuinely down.
        What DOES fail fast is missing/malformed config (see __init__), since
        that's a deploy-time mistake, not a transient network state.
        """
        self._loaded = True
        try:
            resp = self._http.get(self.health_url, timeout=15.0)
            resp.raise_for_status()
            logger.info("Modal inference service reachable: %s", resp.json())
        except Exception as exc:
            logger.warning(
                "Modal health check failed at startup (%s) — continuing; "
                "the endpoint may just be cold. First prediction request "
                "will surface a real error if it's actually down.", exc)

    @property
    def is_loaded(self) -> bool:
        return self._loaded

    def _stage_upload(self, image_bytes: bytes) -> tuple[str, str]:
        """Upload image_bytes to a throwaway path in the relay bucket and
        return (path, signed_url). Extension/content-type are generic —
        Modal's PIL.Image.open() sniffs the real format from the file
        signature, not from either of these."""
        path = f"{uuid.uuid4().hex}.bin"
        self._supabase.storage.from_(self.relay_bucket).upload(
            path, image_bytes,
            file_options={"content-type": "application/octet-stream"},
        )
        signed = self._supabase.storage.from_(self.relay_bucket).create_signed_url(
            path, self.SIGNED_URL_TTL_SECONDS)
        # supabase-py has returned this either as {"signedURL": ...} or
        # {"signedUrl": ...} across versions — check both rather than
        # pinning to one and breaking silently on the next dependency bump.
        signed_url = signed.get("signedURL") or signed.get("signedUrl")
        if not signed_url:
            raise RuntimeError(f"Supabase did not return a signed URL: {signed!r}")
        return path, signed_url

    def _cleanup(self, path: str) -> None:
        try:
            self._supabase.storage.from_(self.relay_bucket).remove([path])
        except Exception as exc:
            # Not fatal to the request that already got its prediction — an
            # orphaned relay object just needs manual/periodic cleanup, it
            # doesn't corrupt anything.
            logger.warning("Failed to clean up relay object %s: %s", path, exc)

    def predict(self, image_bytes: bytes) -> dict:
        if not self.is_loaded:
            raise RuntimeError("Predictor not loaded")

        path, signed_url = self._stage_upload(image_bytes)
        try:
            resp = self._http.post(
                self.predict_url,
                json={"image_url": signed_url},
                timeout=self.request_timeout,
            )
            resp.raise_for_status()
            result = resp.json()
        except httpx.HTTPStatusError as exc:
            # Modal's FastAPI wrapper returns 4xx/5xx with a JSON detail body
            # for the same input errors _predict_bytes() raises locally
            # (bad image, no tissue detected, etc.) — surface that detail
            # rather than a bare status code.
            detail = exc.response.text
            raise RuntimeError(
                f"Modal inference request failed ({exc.response.status_code}): {detail}"
            ) from exc
        except httpx.TimeoutException as exc:
            raise RuntimeError(
                f"Modal inference request timed out after {self.request_timeout}s "
                f"(cold start + inference can be slow on first use)"
            ) from exc
        finally:
            self._cleanup(path)

        for key in ("spots", "top_genes"):
            if key not in result:
                raise RuntimeError(f"Modal response missing {key!r}: {result!r}")

        result.setdefault("model_version", self._fallback_model_version)
        return result

    # ------------------------------------------------------------------
    # Grad-CAM
    # ------------------------------------------------------------------

    # How long a slide stays in the relay bucket after its last Grad-CAM
    # batch. Only needs to bridge the gap between consecutive batches.
    GRADCAM_STAGE_IDLE_SECONDS = 600

    def _drop_gradcam_stage(self) -> None:
        with self._stage_lock:
            stage, self._gradcam_stage = self._gradcam_stage, None
            if self._gradcam_timer is not None:
                self._gradcam_timer.cancel()
                self._gradcam_timer = None
        if stage is not None:
            self._cleanup(stage["path"])

    def _stage_for_gradcam(self, image_bytes: bytes) -> str:
        """Signed URL for this slide, uploading it only if it isn't already
        the staged one. Refreshes the idle timer on every call."""
        import time

        key = hashlib.sha256(image_bytes).hexdigest()
        with self._stage_lock:
            stage = self._gradcam_stage
            same = stage is not None and stage["key"] == key
        if not same:
            self._drop_gradcam_stage()
            path, url = self._stage_upload(image_bytes)
            stage = {"key": key, "path": path, "url": url,
                     "url_expires": time.monotonic() + self.SIGNED_URL_TTL_SECONDS}
            with self._stage_lock:
                self._gradcam_stage = stage
        elif stage["url_expires"] - time.monotonic() < 120:
            # Same object, fresh signature — the URL path (which is what
            # the Modal side keys its tile cache on) does not change.
            signed = self._supabase.storage.from_(self.relay_bucket).create_signed_url(
                stage["path"], self.SIGNED_URL_TTL_SECONDS)
            stage["url"] = signed.get("signedURL") or signed.get("signedUrl")
            stage["url_expires"] = time.monotonic() + self.SIGNED_URL_TTL_SECONDS

        with self._stage_lock:
            if self._gradcam_timer is not None:
                self._gradcam_timer.cancel()
            self._gradcam_timer = threading.Timer(
                self.GRADCAM_STAGE_IDLE_SECONDS, self._drop_gradcam_stage)
            self._gradcam_timer.daemon = True
            self._gradcam_timer.start()
        return stage["url"]

    def explain_batch(self, image_bytes: bytes, spot_indices: list[int],
                      gene: str | None = None) -> list[TileResult]:
        if not self.is_loaded:
            raise RuntimeError("Predictor not loaded")
        if not self.gradcam_url:
            raise NotImplementedError(
                "Grad-CAM is not configured: set MODAL_GRADCAM_URL to the "
                "deployed modal_gradcam_app endpoint")

        signed_url = self._stage_for_gradcam(image_bytes)
        try:
            resp = self._http.post(
                self.gradcam_url,
                json={"image_url": signed_url, "spot_indices": spot_indices, "gene": gene},
                timeout=self.request_timeout,
            )
            resp.raise_for_status()
            tiles = resp.json()["tiles"]
        except httpx.HTTPStatusError as exc:
            detail = exc.response.text
            if exc.response.status_code == 400:
                raise ValueError(detail) from exc     # -> HTTP 400 in routes.py
            raise RuntimeError(
                f"Modal Grad-CAM request failed ({exc.response.status_code}): {detail}"
            ) from exc
        except httpx.TimeoutException as exc:
            raise RuntimeError(
                f"Modal Grad-CAM request timed out after {self.request_timeout}s") from exc

        by_index = {t["spot_index"]: t for t in tiles}
        try:
            return [tile_from_json(by_index[i]) for i in spot_indices]
        except KeyError as exc:
            raise RuntimeError(f"Modal Grad-CAM response missing spot {exc}") from exc

    def explain(self, image_bytes: bytes, spot_index: int, gene: str | None = None) -> bytes:
        return self.explain_batch(image_bytes, [spot_index], gene)[0].png
