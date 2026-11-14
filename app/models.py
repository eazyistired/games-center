"""ORM models. Change these -> add an Alembic migration (see docs/DEVELOPMENT.md)."""

from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy import JSON, Date, DateTime, Float, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def utcnow() -> datetime:
    """Naive UTC timestamp (SQLite has no timezone support)."""
    return datetime.now(UTC).replace(tzinfo=None)


class Player(Base):
    __tablename__ = "players"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(60), unique=True)
    emoji: Mapped[str] = mapped_column(String(16), default="🙂")
    active: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class GameNight(Base):
    __tablename__ = "game_nights"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    date: Mapped[date] = mapped_column(Date, index=True)
    label: Mapped[str | None] = mapped_column(String(100), default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Game(Base):
    """Admin-controlled state for a game; the game itself is described by its manifest."""

    __tablename__ = "games"

    id: Mapped[str] = mapped_column(String(60), primary_key=True)
    enabled: Mapped[bool] = mapped_column(default=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    settings: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class GameSession(Base):
    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    game_id: Mapped[str] = mapped_column(ForeignKey("games.id"), index=True)
    night_id: Mapped[int] = mapped_column(ForeignKey("game_nights.id"), index=True)
    mode: Mapped[str] = mapped_column(String(10), default="solo")  # solo | teams
    settings: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    # (collecting | lobby ->) active -> finished | abandoned ; finished <-> void (admin)
    status: Mapped[str] = mapped_column(String(12), default="active", index=True)
    progress: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=None)
    details: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=None)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    # live play: which device drives the session (one-phone mode) and when it was last seen
    device_mode: Mapped[str] = mapped_column(String(10), default="single", server_default="single")
    controller_device_id: Mapped[str | None] = mapped_column(String(64), default=None)
    controller_seen_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    state_version: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # scores so far, reported by the game with each save (used to auto-finish idle sessions)
    partial_result: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=None)

    night: Mapped[GameNight] = relationship()
    teams: Mapped[list[SessionTeam]] = relationship(
        cascade="all, delete-orphan", order_by="SessionTeam.idx"
    )
    participants: Mapped[list[SessionParticipant]] = relationship(
        cascade="all, delete-orphan", order_by="SessionParticipant.id"
    )


class SessionTeam(Base):
    __tablename__ = "session_teams"
    __table_args__ = (UniqueConstraint("session_id", "idx"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id", ondelete="CASCADE"))
    idx: Mapped[int] = mapped_column(Integer)
    name: Mapped[str] = mapped_column(String(40))
    color: Mapped[str] = mapped_column(String(16), default="#7c5cff")
    score: Mapped[float | None] = mapped_column(Float, default=None)
    placement: Mapped[int | None] = mapped_column(Integer, default=None)
    points: Mapped[float | None] = mapped_column(Float, default=None)


class SessionParticipant(Base):
    __tablename__ = "session_participants"
    __table_args__ = (UniqueConstraint("session_id", "player_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[int] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), index=True
    )
    player_id: Mapped[int] = mapped_column(ForeignKey("players.id"), index=True)
    team_idx: Mapped[int | None] = mapped_column(Integer, default=None)
    score: Mapped[float | None] = mapped_column(Float, default=None)
    placement: Mapped[int | None] = mapped_column(Integer, default=None)
    points: Mapped[float | None] = mapped_column(Float, default=None)
    # multi-phone play: the phone that holds this seat
    device_id: Mapped[str | None] = mapped_column(String(64), default=None)
    joined_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)

    player: Mapped[Player] = relationship()


class Crew(Base):
    """A saved favourite lineup (e.g. 'The usual crew')."""

    __tablename__ = "crews"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(60), unique=True)
    player_ids: Mapped[list[int]] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Deck(Base):
    __tablename__ = "decks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    slug: Mapped[str] = mapped_column(String(80), unique=True)
    game_id: Mapped[str] = mapped_column(String(60), index=True)
    name: Mapped[str] = mapped_column(String(60))
    emoji: Mapped[str] = mapped_column(String(16), default="🃏")
    description: Mapped[str] = mapped_column(String(200), default="")
    builtin: Mapped[bool] = mapped_column(default=False)
    enabled: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    words: Mapped[list[Word]] = relationship(cascade="all, delete-orphan", order_by="Word.text")


class Word(Base):
    __tablename__ = "words"
    __table_args__ = (UniqueConstraint("deck_id", "text"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    deck_id: Mapped[int] = mapped_column(ForeignKey("decks.id", ondelete="CASCADE"), index=True)
    text: Mapped[str] = mapped_column(String(120))
    active: Mapped[bool] = mapped_column(default=True)
    # who wrote it (friends' words): Heads Up won't give you your own word, Imposter won't make
    # the author the imposter
    author_player_id: Mapped[int | None] = mapped_column(
        ForeignKey("players.id", ondelete="SET NULL"), default=None
    )


class WordPlay(Base):
    """One word shown during a session and what happened to it."""

    __tablename__ = "word_plays"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[int] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), index=True
    )
    word_id: Mapped[int] = mapped_column(ForeignKey("words.id", ondelete="CASCADE"), index=True)
    result: Mapped[str] = mapped_column(String(10))  # correct | pass


class Setting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(60), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON)


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    action: Mapped[str] = mapped_column(String(40))
    entity: Mapped[str] = mapped_column(String(40))
    entity_id: Mapped[str | None] = mapped_column(String(40), default=None)
    detail: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=None)


class Device(Base):
    """An anonymous phone/browser. Remembers which player it is (no login)."""

    __tablename__ = "devices"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    player_id: Mapped[int | None] = mapped_column(
        ForeignKey("players.id", ondelete="SET NULL"), default=None, index=True
    )
    label: Mapped[str] = mapped_column(String(120), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_seen: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    player: Mapped[Player | None] = relationship()


class TakeoverRequest(Base):
    """A phone asking to take control of a session; another phone must allow it."""

    __tablename__ = "takeover_requests"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[int] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), index=True
    )
    requester_device_id: Mapped[str] = mapped_column(String(64), index=True)
    approver_device_id: Mapped[str] = mapped_column(String(64), index=True)
    reason: Mapped[str] = mapped_column(String(20))  # controller | identity
    status: Mapped[str] = mapped_column(String(12), default="pending")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)


class SessionWord(Base):
    """A word a player added while a session was collecting words (secret from the others)."""

    __tablename__ = "session_words"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[int] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), index=True
    )
    player_id: Mapped[int | None] = mapped_column(
        ForeignKey("players.id", ondelete="SET NULL"), default=None
    )
    device_id: Mapped[str] = mapped_column(String(64))
    text: Mapped[str] = mapped_column(String(120))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class IdentityRequest(Base):
    """A phone asking to use a name (player) that another phone holds; that phone must allow it."""

    __tablename__ = "identity_requests"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    player_id: Mapped[int] = mapped_column(ForeignKey("players.id", ondelete="CASCADE"), index=True)
    requester_device_id: Mapped[str] = mapped_column(String(64), index=True)
    owner_device_id: Mapped[str] = mapped_column(String(64), index=True)
    status: Mapped[str] = mapped_column(
        String(12), default="pending"
    )  # pending|approved|denied|cancelled
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)


# sessions that are not over yet (shown under "Live now")
LIVE_STATUSES = ("active", "lobby", "collecting")
