from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router
from app.core.config import settings
from app.services.predictor import get_predictor


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup — model loaded ONCE, not per request.
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