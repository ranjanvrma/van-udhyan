"""
Application Configuration Settings Module
Reads configuration settings from environment variables safely without hard-coded secrets.
"""

import os
from pathlib import Path
from dotenv import load_dotenv

# Load backend/.env if present (keeps secrets out of source code)
_env_path = Path(__file__).resolve().parent.parent.parent / ".env"
load_dotenv(_env_path)


def _str_env(name: str, default: str = "") -> str:
    v = os.environ.get(name)
    return v.strip() if v else default


def _list_env(name: str) -> list:
    """Parses a comma-separated env var into a list of trimmed non-empty strings."""
    raw = os.environ.get(name, "")
    return [item.strip() for item in raw.split(",") if item.strip()]


class Settings:
    PROJECT_NAME: str = "Van Udyan Biodiversity Intelligence Platform API"
    API_V1_STR: str = "/api/v1"

    @property
    def DATABASE_URL(self) -> str:
        url = os.environ.get("DATABASE_URL")
        if url:
            # Supabase and some providers hand out "postgres://" URLs which SQLAlchemy no longer accepts
            if url.startswith("postgres://"):
                url = "postgresql://" + url[len("postgres://"):]
            return url

        host = os.environ.get("PGHOST", "localhost")
        port = os.environ.get("PGPORT", "5432")
        user = os.environ.get("PGUSER", "postgres")
        password = os.environ.get("PGPASSWORD", "postgres")
        dbname = os.environ.get("PGDATABASE", "van_udyan_db")

        return f"postgresql://{user}:{password}@{host}:{port}/{dbname}"

    @property
    def PLANTNET_API_KEY(self) -> str:
        return _str_env("PLANTNET_API_KEY")

    @property
    def PLANTNET_PROJECT(self) -> str:
        # Regional flora queried for identification (list: GET https://my-api.plantnet.org/v2/projects)
        return _str_env("PLANTNET_PROJECT", "k-indian-subcontinent")

    @property
    def NGO_ADMIN_PASSWORD(self) -> str:
        return _str_env("NGO_ADMIN_PASSWORD", "rswf-admin-pass")

    # Public base URL of this backend, used to build absolute photo URLs when needed.
    # When unset the frontend prefixes its API_BASE_URL itself (matches local dev).
    @property
    def BACKEND_PUBLIC_URL(self) -> str:
        return _str_env("BACKEND_PUBLIC_URL").rstrip("/")

    # Directory for uploaded photos; overridable so a cloud host can mount a volume elsewhere
    @property
    def UPLOADS_DIR(self) -> str:
        return _str_env("UPLOADS_DIR") or ""

    # Directory for cached photo thumbnails
    @property
    def THUMBS_DIR(self) -> str:
        return _str_env("THUMBS_DIR") or ""

    # Supabase Storage settings (optional). When configured, uploads go to the Supabase bucket
    # instead of the local disk, so photos survive host redeploys with no persistent volume.
    @property
    def SUPABASE_URL(self) -> str:
        return _str_env("SUPABASE_URL").rstrip("/")

    @property
    def SUPABASE_SERVICE_KEY(self) -> str:
        # Service role key: has write access to Storage. Keep secret, server-side only.
        return _str_env("SUPABASE_SERVICE_KEY")

    @property
    def SUPABASE_BUCKET(self) -> str:
        return _str_env("SUPABASE_BUCKET", "van-udyan-photos")

    @property
    def PHOTO_STORAGE_BACKEND(self) -> str:
        """'supabase' when Supabase credentials are set, otherwise 'local'."""
        if self.SUPABASE_URL and self.SUPABASE_SERVICE_KEY:
            return "supabase"
        return "local"

    @property
    def CORS_ORIGINS(self) -> list:
        """Allowed origins for browser requests. CORS_ORIGINS env var adds deployed frontend URLs."""
        defaults = [
            "http://localhost",
            "http://localhost:3000",
            "http://localhost:5173",
            "http://127.0.0.1:3000",
            "http://127.0.0.1:5173",
        ]
        extra = _list_env("CORS_ORIGINS")
        # Deduplicate while keeping order
        seen = set()
        result = []
        for origin in defaults + extra:
            if origin not in seen:
                seen.add(origin)
                result.append(origin)
        return result


settings = Settings()
