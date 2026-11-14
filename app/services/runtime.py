"""Runtime settings: env defaults that the admin can override from the dashboard."""

from __future__ import annotations

from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import Setting

SCORING_FORMULAS = {
    "placement": "Placement: winner 100, last 0, the rest spread evenly (ties share)",
    "winner": "Winner takes all: 100 for the winner(s), 0 for everyone else",
}


def _defaults() -> dict[str, Any]:
    s = get_settings()
    return {
        "site_name": s.site_name,
        "timezone": s.timezone,
        "night_cutoff_hour": s.night_cutoff_hour,
        "scoring_formula": "placement",
        "min_sessions": 3,
        "quiet_seconds": 30,
        "idle_hours": s.idle_hours,
    }


def get_runtime(db: Session) -> dict[str, Any]:
    values = _defaults()
    for row in db.scalars(select(Setting)):
        if row.key in values:
            values[row.key] = row.value
    return values


def validate(updates: dict[str, Any]) -> dict[str, Any]:
    clean: dict[str, Any] = {}
    for key, value in updates.items():
        if key == "site_name":
            value = str(value).strip()[:60]
            if not value:
                raise ValueError("Site name cannot be empty")
        elif key == "timezone":
            try:
                ZoneInfo(str(value))
            except (ZoneInfoNotFoundError, ValueError) as exc:
                raise ValueError(f"Unknown timezone: {value}") from exc
        elif key == "night_cutoff_hour":
            value = int(value)
            if not 0 <= value <= 12:
                raise ValueError("Night cutoff hour must be between 0 and 12")
        elif key == "scoring_formula":
            if value not in SCORING_FORMULAS:
                raise ValueError("Unknown scoring formula")
        elif key == "quiet_seconds":
            value = int(value)
            if not 10 <= value <= 600:
                raise ValueError("'Quiet after' must be between 10 and 600 seconds")
        elif key == "idle_hours":
            value = float(value)
            if not 0.25 <= value <= 48:
                raise ValueError("Idle games must close after 0.25-48 hours")
        elif key == "min_sessions":
            value = int(value)
            if not 1 <= value <= 100:
                raise ValueError("Minimum sessions must be between 1 and 100")
        else:
            raise ValueError(f"Unknown setting: {key}")
        clean[key] = value
    return clean


def set_runtime(db: Session, updates: dict[str, Any]) -> dict[str, Any]:
    for key, value in validate(updates).items():
        row = db.get(Setting, key)
        if row is None:
            db.add(Setting(key=key, value=value))
        else:
            row.value = value
    db.flush()
    values = get_runtime(db)
    apply_runtime(values)
    return values


def apply_runtime(values: dict[str, Any]) -> None:
    """Push settings that live outside the DB (in-process) to where they're used."""
    from . import live

    live.configure(values["quiet_seconds"])
