"""
Main FastAPI Application Entry Point
Initializes FastAPI app, configures CORS middleware, registers v1 API routers, mounts the
photo serving layer, and exposes health and readiness endpoints.
"""

from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps
import logging
import sys
import os
import re

# Ensure backend root is in python path
sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.core.config import settings
from app.services import photo_storage, state_sync
from app.api.v1 import health, observations, species, zones, geography, map, statistics, planted_plants, export, analytics, reports

log = logging.getLogger("van-udyan")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Startup: pull the latest NGO stores from Postgres onto the local disk so an ephemeral host
    (Render free) starts with the data it had before the previous restart.
    Shutdown: nothing to clean up.
    """
    try:
        pulled = state_sync.pull_all()
        synced = [k for k, ok in pulled.items() if ok]
        if synced:
            log.info("state_sync: pulled %s from database", ", ".join(synced))
    except Exception as e:
        log.warning("state_sync: startup pull failed, using local JSON only (%s)", e)
    yield


app = FastAPI(
    title=settings.PROJECT_NAME,
    description="Geospatial Biodiversity Mapping, Monitoring & AI Analytics System for RSWF NGO",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
    lifespan=lifespan,
)

# CORS: allowed origins come from config.CORS_ORIGINS (defaults + env-provided deployed URLs)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"],
)

# Photo storage: local filesystem by default; Supabase Storage when its env vars are set.
# Local mode mounts /uploads directly from the uploads directory for the fastest possible transfer.
if photo_storage.is_local():
    app.mount("/uploads", StaticFiles(directory=photo_storage.uploads_dir()), name="uploads")
else:
    @app.get("/uploads/{name}", include_in_schema=False)
    def photo_original(name: str):
        """Redirects to the Supabase Storage public URL (no backend bandwidth used)."""
        if not photo_storage.is_safe_name(name):
            raise HTTPException(status_code=404, detail="Not found")
        return RedirectResponse(url=photo_storage.public_url(name), status_code=307)


THUMB_NAME = re.compile(r"^upload_[A-Za-z0-9_]+\.(jpg|jpeg|png|webp)$", re.IGNORECASE)
THUMB_SIZE = 320


@app.get("/thumbs/{name}", include_in_schema=False)
def photo_thumbnail(name: str):
    """Small cached preview for tables and map popups. Falls back to generating on the fly."""
    if not THUMB_NAME.match(name):
        raise HTTPException(status_code=404, detail="Not found")

    thumbs_dir = photo_storage.thumbs_dir()
    os.makedirs(thumbs_dir, exist_ok=True)

    thumb = os.path.join(
        thumbs_dir,
        os.path.splitext(name)[0] + ".jpg"
    )

    if not os.path.exists(thumb):
        source_path = photo_storage.read_to_tempfile(name)

        if source_path is None:
            raise HTTPException(status_code=404, detail="Photo not found")

        try:
            with Image.open(source_path) as img:
                img = ImageOps.exif_transpose(img).convert("RGB")
                img.thumbnail(
                    (THUMB_SIZE, THUMB_SIZE),
                    Image.Resampling.LANCZOS
                )
                img.save(thumb, "JPEG", quality=82)
        finally:
            photo_storage.cleanup_tempfile(source_path)

    return FileResponse(
        thumb,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=86400"}
    )


# Register Health Endpoints
app.include_router(health.router)

# Register API v1 Routers
api_v1_prefix = settings.API_V1_STR

# Dashboard unlock dialog hits /api/v1/auth/verify — expose the health router's
# /auth/verify endpoint under the versioned prefix as well
from fastapi import APIRouter as _APIRouter, Depends as _Depends
from fastapi.responses import Response as _Response
from app.core.security import verify_ngo_admin_password as _verify_pw
_auth_router = _APIRouter(tags=["Auth"])

@_auth_router.post("/auth/verify", include_in_schema=False)
def _auth_verify(_: str = _Depends(_verify_pw)):
    return _Response(status_code=204)

app.include_router(_auth_router, prefix=api_v1_prefix)

app.include_router(observations.router, prefix=api_v1_prefix)
app.include_router(species.router, prefix=api_v1_prefix)
app.include_router(zones.router, prefix=api_v1_prefix)
app.include_router(geography.router, prefix=api_v1_prefix)
app.include_router(map.router, prefix=api_v1_prefix)
app.include_router(statistics.router, prefix=api_v1_prefix)
app.include_router(planted_plants.router, prefix=api_v1_prefix)
app.include_router(export.router, prefix=api_v1_prefix)
app.include_router(analytics.router, prefix=api_v1_prefix)
app.include_router(reports.router, prefix=api_v1_prefix)


@app.get("/", include_in_schema=False)
def root():
    return {
        "message": "Welcome to Van Udyan Biodiversity Intelligence Platform API",
        "documentation": "/docs",
        "health": "/health",
        "api_v1": settings.API_V1_STR,
        "photo_storage": settings.PHOTO_STORAGE_BACKEND,
    }


@app.get("/ready", include_in_schema=False)
def readiness():
    """Lightweight readiness check for cloud load balancers (does not hit the database)."""
    return Response(status_code=204)


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("app.main:app", host="0.0.0.0", port=port, reload=False)
