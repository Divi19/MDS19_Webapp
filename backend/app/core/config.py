from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    app_name: str = "MDS19 Prediction API"
    debug: bool = True

    # Model — paths come from env so deployment needs no code change
    model_checkpoint_path: str = ""
    model_data_root: str = ""
    use_dummy_predictor: bool = True

    # Supabase
    supabase_url: str = ""
    supabase_key: str = ""

    # CORS — frontend origins allowed to call this API
    cors_origins: list[str] = ["http://localhost:3000"]

    class Config:
        env_file = ".env"


settings = Settings()