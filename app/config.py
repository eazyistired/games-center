"""Environment configuration (read once at startup)."""

from __future__ import annotations

import os
import secrets
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


class Settings:
    def __init__(self) -> None:
        env = os.environ
        self.data_dir = Path(env.get("DATA_DIR", ROOT / "data"))
        self.games_dir = Path(env.get("GAMES_DIR", ROOT / "games"))
        self.web_dir = Path(env.get("WEB_DIR", ROOT / "web"))
        self.admin_password = env.get("ADMIN_PASSWORD", "")
        self.timezone = env.get("TZ") or "UTC"
        self.night_cutoff_hour = int(env.get("NIGHT_CUTOFF_HOUR", "6"))
        self.site_name = env.get("SITE_NAME", "Games Center")
        self.backup_keep = int(env.get("BACKUP_KEEP", "14"))
        self.auto_backup = _bool(env.get("AUTO_BACKUP"), True)
        self.secure_cookies = _bool(env.get("SECURE_COOKIES"), False)
        self._secret_key = env.get("SECRET_KEY", "")

    @property
    def db_path(self) -> Path:
        return self.data_dir / "games.db"

    @property
    def backups_dir(self) -> Path:
        return self.data_dir / "backups"

    @property
    def secret_key(self) -> str:
        """SECRET_KEY env var, or a random key persisted in the data dir."""
        if self._secret_key:
            return self._secret_key
        key_file = self.data_dir / ".secret_key"
        if key_file.exists():
            self._secret_key = key_file.read_text().strip()
        else:
            self.data_dir.mkdir(parents=True, exist_ok=True)
            self._secret_key = secrets.token_urlsafe(48)
            key_file.write_text(self._secret_key)
            key_file.chmod(0o600)
        return self._secret_key


@lru_cache
def get_settings() -> Settings:
    return Settings()
