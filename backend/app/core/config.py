from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", protected_namespaces=("settings_",))

    app_name: str = "MDS19 Prediction API"
    debug: bool = True

    # Model — paths come from env so deployment needs no code change
    mode: Literal["real", "demo"] = "demo"
    model_checkpoint_path: str = ""
    model_data_root: str = ""
    max_concurrent_predictions: int = Field(default=1, ge=1, le=8)

    # Supabase
    supabase_url: str = ""
    supabase_key: str = ""

    # CORS — frontend origins allowed to call this API
    cors_origins: list[str] = ["http://localhost:3000"]


settings = Settings()