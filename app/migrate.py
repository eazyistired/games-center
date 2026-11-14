"""Run Alembic migrations programmatically (called on startup)."""

from pathlib import Path

from alembic import command
from alembic.config import Config


def run_migrations(db_path: Path) -> None:
    cfg = Config()
    cfg.set_main_option("script_location", str(Path(__file__).parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", f"sqlite:///{db_path}")
    command.upgrade(cfg, "head")
