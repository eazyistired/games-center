"""Backups: SQLite online backups to /data/backups plus full JSON export/import."""

from __future__ import annotations

import logging
import sqlite3
from datetime import date, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import Date, DateTime, delete, insert, select
from sqlalchemy.orm import Session

from .. import __version__
from ..config import Settings
from ..db import Base
from ..models import utcnow

log = logging.getLogger(__name__)


def make_backup(settings: Settings, reason: str = "auto") -> Path:
    settings.backups_dir.mkdir(parents=True, exist_ok=True)
    stamp = utcnow().strftime("%Y%m%d-%H%M%S")
    target = settings.backups_dir / f"games-{stamp}-{reason}.db"
    tmp = target.with_suffix(".tmp")
    src = sqlite3.connect(settings.db_path)
    dst = sqlite3.connect(tmp)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    tmp.replace(target)
    prune(settings)
    log.info("backup written: %s", target.name)
    return target


def list_backups(settings: Settings) -> list[dict[str, Any]]:
    if not settings.backups_dir.is_dir():
        return []
    files = sorted(settings.backups_dir.glob("games-*.db"), reverse=True)
    return [
        {
            "name": f.name,
            "size": f.stat().st_size,
            "created_at": datetime.fromtimestamp(f.stat().st_mtime).isoformat(),
        }
        for f in files
    ]


def prune(settings: Settings) -> None:
    files = sorted(settings.backups_dir.glob("games-*.db"), reverse=True)
    for old in files[settings.backup_keep :]:
        old.unlink(missing_ok=True)


def latest_backup_age_hours(settings: Settings) -> float | None:
    files = list(settings.backups_dir.glob("games-*.db")) if settings.backups_dir.is_dir() else []
    if not files:
        return None
    newest = max(f.stat().st_mtime for f in files)
    return (datetime.now().timestamp() - newest) / 3600


def _jsonable(value: Any) -> Any:
    if isinstance(value, datetime | date):
        return value.isoformat()
    return value


def export_json(db: Session) -> dict[str, Any]:
    tables = {}
    for table in Base.metadata.sorted_tables:
        rows = db.execute(select(table)).mappings().all()
        tables[table.name] = [{k: _jsonable(v) for k, v in row.items()} for row in rows]
    return {
        "app": "games-center",
        "version": __version__,
        "exported_at": utcnow().isoformat(),
        "tables": tables,
    }


def import_json(db: Session, data: dict[str, Any]) -> dict[str, int]:
    """Replace ALL data with the content of an export. Caller should back up first."""
    if data.get("app") != "games-center" or "tables" not in data:
        raise ValueError("Not a Games Center export file")
    tables = data["tables"]
    for table in reversed(Base.metadata.sorted_tables):
        db.execute(delete(table))
    counts = {}
    for table in Base.metadata.sorted_tables:
        rows = tables.get(table.name, [])
        converters = {}
        for col in table.columns:
            if isinstance(col.type, DateTime):
                converters[col.name] = datetime.fromisoformat
            elif isinstance(col.type, Date):
                converters[col.name] = date.fromisoformat
        clean_rows = []
        for row in rows:
            clean = {}
            for col in table.columns:
                if col.name in row:
                    v = row[col.name]
                    if v is not None and col.name in converters:
                        v = converters[col.name](v)
                    clean[col.name] = v
            clean_rows.append(clean)
        if clean_rows:
            db.execute(insert(table), clean_rows)
        counts[table.name] = len(clean_rows)
    db.flush()
    return counts
