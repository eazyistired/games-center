"""Game nights: sessions are grouped by local date, with a cutoff hour (1am = previous night)."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import GameNight, utcnow
from .runtime import get_runtime


def night_date_for(dt_utc: datetime, tz: str, cutoff_hour: int) -> date:
    local = dt_utc.replace(tzinfo=UTC).astimezone(ZoneInfo(tz))
    return (local - timedelta(hours=cutoff_hour)).date()


def current_night_date(db: Session, now: datetime | None = None) -> date:
    rt = get_runtime(db)
    return night_date_for(now or utcnow(), rt["timezone"], rt["night_cutoff_hour"])


def get_or_create_night(db: Session, now: datetime | None = None) -> GameNight:
    d = current_night_date(db, now)
    night = db.scalars(
        select(GameNight).where(GameNight.date == d).order_by(GameNight.id.desc())
    ).first()
    if night is None:
        night = GameNight(date=d)
        db.add(night)
        db.flush()
    return night
