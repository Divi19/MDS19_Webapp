from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    app_name: str = "MDS19 Prediction API"
    debug: bool = True

    # Model — paths come from env so deployment needs no code change.
    # model_data_archive_id: the Google Drive file ID of the gzipped
    # webapp_database tarball main.py's ensure_model_data() downloads on
    # first boot. Its top-level folder name MUST match
    # os.path.basename(model_data_root) — see ensure_model_data()'s
    # docstring. Defaults to the current production bank so this is a no-op
    # unless explicitly overridden (e.g. for a v7 staging deploy).
    model_data_archive_id: str = "1R69pcxfpf1kEyVqyP2noEEltVcIiWR2R"
    model_checkpoint_path: str = ""
    model_data_root: str = ""
    use_dummy_predictor: bool = True
    # "densenet121" (baseline) or "h0mini" (v7 dual-crop, per
    # MDS19_Deployment_Brief.md). Must match whatever produced model_data_root
    # — a mismatch matches across two unrelated embedding spaces and fails
    # silently. See scripts/acceptance_test_fold0.py.
    encoder_backend: str = "densenet121"

    # Spatial smoothing (Path A). On by default; set ENABLE_SMOOTHING=false
    # on the host to fall back to raw retrieval without a code change.
    enable_smoothing: bool = True
    smoothing_alpha: float = 0.6

    # Modal GPU inference (see MDS19_Modal_Handover.md). When true,
    # get_predictor() returns ModalPredictor and ignores use_dummy_predictor
    # / encoder_backend / model_checkpoint_path / model_data_root entirely —
    # Render no longer loads H0-mini or the reference bank itself, it just
    # relays to the deployed Modal endpoint. Takes priority over
    # use_dummy_predictor so flipping this on is a one-variable change.
    use_modal_inference: bool = False
    modal_predict_url: str = (
        "https://brandonchiew--mds19-v7-inference-v7predictor-predict.modal.run"
    )
    modal_health_url: str = (
        "https://brandonchiew--mds19-v7-inference-v7predictor-health.modal.run"
    )
    # Grad-CAM endpoint of backend/modal_gradcam_app.py (a separate Modal app
    # from the predict one, so the two can be deployed independently).
    modal_gradcam_url: str = (
        "https://brandonchiew--mds19-v7-gradcam-v7gradcam-explain-batch.modal.run"
    )
    modal_request_timeout: float = 150.0  # seconds; covers a cold start + inference

    # Supabase
    supabase_url: str = ""
    supabase_key: str = ""
    # Service-role key, backend-only, NEVER shipped to the frontend or
    # logged. Only needed when use_modal_inference=true: ModalPredictor
    # stages each upload as a short-lived relay object under no particular
    # auth.uid(), which the per-user RLS policies on he-images-style buckets
    # would otherwise reject — the service role bypasses RLS for that one
    # write+read+delete.
    supabase_service_role_key: str = ""
    supabase_relay_bucket: str = "model-relay"

    # CORS — frontend origins allowed to call this API
    cors_origins: list[str] = ["http://localhost:3000"]

    class Config:
        env_file = ".env"


settings = Settings()
