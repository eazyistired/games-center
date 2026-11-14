"""Session lifecycle: create -> (progress) -> result | abandon."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import (
    LIVE_STATUSES,
    Game,
    GameSession,
    Player,
    SessionParticipant,
    SessionTeam,
    WordPlay,
    utcnow,
)
from .nights import get_or_create_night
from .registry import get_manifest, merged_settings
from .runtime import get_runtime
from .scoring import recompute_session

TEAM_COLORS = ["#d9452b", "#3d8fd6", "#f5c518", "#1fa35b", "#a26be0", "#e8892b"]
TEAM_NAMES = ["Red", "Blue", "Yellow", "Green", "Purple", "Orange"]


class SessionError(ValueError):
    pass


def iso(dt: datetime | None) -> str | None:
    return dt.isoformat() + "Z" if dt else None


def session_out(s: GameSession) -> dict[str, Any]:
    manifest = get_manifest(s.game_id) or {}
    members: dict[int, list[int]] = {}
    for p in s.participants:
        if p.team_idx is not None:
            members.setdefault(p.team_idx, []).append(p.player_id)
    return {
        "id": s.id,
        "game_id": s.game_id,
        "game": {
            "id": s.game_id,
            "name": manifest.get("name", s.game_id),
            "emoji": manifest.get("emoji", "🎲"),
            "url": f"/games/{s.game_id}/{manifest.get('entry', 'index.html')}?session={s.id}",
            "scoring": manifest.get("scoring", {}),
        },
        "mode": s.mode,
        "status": s.status,
        "settings": s.settings,
        "progress": s.progress,
        "details": s.details,
        "started_at": iso(s.started_at),
        "finished_at": iso(s.finished_at),
        "night": {"id": s.night.id, "date": s.night.date.isoformat(), "label": s.night.label},
        "teams": [
            {
                "idx": t.idx,
                "name": t.name,
                "color": t.color,
                "score": t.score,
                "placement": t.placement,
                "points": t.points,
                "player_ids": members.get(t.idx, []),
            }
            for t in s.teams
        ],
        "participants": [
            {
                "player_id": p.player_id,
                "name": p.player.name,
                "emoji": p.player.emoji,
                "team_idx": p.team_idx,
                "score": p.score,
                "placement": p.placement,
                "points": p.points,
            }
            for p in s.participants
        ],
    }


def create_session(
    db: Session,
    game_id: str,
    mode: str,
    player_ids: list[int],
    teams: list[dict[str, Any]] | None,
    settings: dict[str, Any] | None,
    device_id: str | None = None,
    device_mode: str = "single",
) -> GameSession:
    manifest = get_manifest(game_id)
    game = db.get(Game, game_id)
    if manifest is None or game is None or not game.enabled:
        raise SessionError("Unknown or disabled game")
    if mode not in manifest["modes"]:
        raise SessionError(f"Mode '{mode}' is not supported by this game")
    if device_mode not in manifest.get("devices", ["single"]):
        raise SessionError("This game can't be played that way")
    if device_mode == "multi":
        from ..engines import get_engine

        if get_engine(game_id) is None:
            raise SessionError("This game has no multi-phone engine")
        if not device_id:
            raise SessionError("Missing device id")

    if mode == "teams":
        if not teams:
            raise SessionError("Teams are required in teams mode")
        player_ids = [pid for t in teams for pid in t.get("player_ids", [])]
        lim = manifest["teams"]
        if not lim["min"] <= len(teams) <= lim["max"]:
            raise SessionError(f"This game needs {lim['min']}-{lim['max']} teams")
        if any(not t.get("player_ids") for t in teams):
            raise SessionError("Every team needs at least one player")
        if any(len(t["player_ids"]) < lim["min_size"] for t in teams):
            raise SessionError(f"Every team needs at least {lim['min_size']} players")

    if len(set(player_ids)) != len(player_ids):
        raise SessionError("A player can only be in the lineup once")
    if not manifest["min_players"] <= len(player_ids) <= manifest["max_players"]:
        raise SessionError(
            f"This game needs {manifest['min_players']}-{manifest['max_players']} players"
        )
    players = {p.id: p for p in db.scalars(select(Player).where(Player.id.in_(player_ids)))}
    missing = [pid for pid in player_ids if pid not in players or not players[pid].active]
    if missing:
        raise SessionError(f"Unknown or archived player(s): {missing}")

    session = GameSession(
        game_id=game_id,
        night_id=get_or_create_night(db).id,
        mode=mode,
        settings=merged_settings(manifest, game.settings, settings),
        status="lobby"
        if device_mode == "multi"
        else "collecting"
        if (settings or {}).get("collect_words")
        else "active",
        device_mode=device_mode,
        controller_device_id=device_id,
        controller_seen_at=utcnow() if device_id else None,
    )
    if mode == "teams":
        for idx, t in enumerate(teams or []):
            name = str(t.get("name") or TEAM_NAMES[idx % len(TEAM_NAMES)])[:40]
            color = str(t.get("color") or TEAM_COLORS[idx % len(TEAM_COLORS)])[:16]
            session.teams.append(SessionTeam(idx=idx, name=name, color=color))
            for pid in t["player_ids"]:
                session.participants.append(SessionParticipant(player_id=pid, team_idx=idx))
    else:
        for pid in player_ids:
            session.participants.append(SessionParticipant(player_id=pid))
    db.add(session)
    db.flush()
    db.refresh(session)
    if device_mode == "multi":  # the host takes their own seat if they're in the lineup
        from ..models import Device

        host = db.get(Device, device_id)
        for p in session.participants:
            if host is not None and host.player_id == p.player_id:
                p.device_id, p.joined_at = device_id, utcnow()
        db.flush()
    return session


def submit_result(
    db: Session,
    session: GameSession,
    scores: list[dict[str, Any]],
    details: dict[str, Any] | None,
    word_plays: list[dict[str, Any]] | None,
) -> GameSession:
    if session.status != "active":
        raise SessionError(f"Session is already {session.status}")
    if session.mode == "teams":
        by_idx = {t.idx: t for t in session.teams}
        for entry in scores:
            team = by_idx.get(entry.get("team"))
            if team is None:
                raise SessionError(f"Unknown team: {entry.get('team')}")
            team.score = _num(entry.get("score"))
    else:
        by_pid = {p.player_id: p for p in session.participants}
        for entry in scores:
            part = by_pid.get(entry.get("player_id"))
            if part is None:
                raise SessionError(f"Player {entry.get('player_id')} is not in this session")
            part.score = _num(entry.get("score"))

    if word_plays:
        for wp in word_plays:
            result = "correct" if wp.get("result") == "correct" else "pass"
            if isinstance(wp.get("word_id"), int):
                db.add(WordPlay(session_id=session.id, word_id=wp["word_id"], result=result))

    rt = get_runtime(db)
    manifest = get_manifest(session.game_id) or {}
    recompute_session(
        session, manifest.get("scoring", {}).get("higher_is_better", True), rt["scoring_formula"]
    )
    session.details = details
    session.progress = None
    session.partial_result = None
    session.status = "finished"
    session.finished_at = utcnow()
    db.flush()
    return session


def _num(v: Any) -> float | None:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError) as exc:
        raise SessionError(f"Score must be a number, got {v!r}") from exc


def recent_lineups(db: Session, game_id: str, limit: int = 5) -> list[dict[str, Any]]:
    """Distinct recent lineups for a game (most recent first)."""
    sessions = db.scalars(
        select(GameSession)
        .where(GameSession.game_id == game_id, GameSession.status.in_(["finished", "active"]))
        .order_by(GameSession.started_at.desc())
        .limit(100)
    )
    seen: set[tuple] = set()
    out = []
    for s in sessions:
        players = [p for p in s.participants if p.player.active]
        if not players:
            continue
        if s.mode == "teams":
            teams = [sorted(p.player_id for p in players if p.team_idx == t.idx) for t in s.teams]
            key = ("teams", tuple(sorted(tuple(t) for t in teams)))
        else:
            teams = None
            key = ("solo", tuple(sorted(p.player_id for p in players)))
        if key in seen:
            continue
        seen.add(key)
        out.append(
            {
                "session_id": s.id,
                "mode": s.mode,
                "date": iso(s.started_at),
                "player_ids": [p.player_id for p in players],
                "teams": [
                    {"name": t.name, "color": t.color, "player_ids": ids}
                    for t, ids in zip(s.teams, teams, strict=True)
                ]
                if teams is not None
                else None,
                "settings": s.settings,
            }
        )
        if len(out) >= limit:
            break
    return out


def active_sessions(db: Session, hours: int = 24) -> list[GameSession]:
    since = utcnow() - timedelta(hours=hours)
    return list(
        db.scalars(
            select(GameSession)
            .where(GameSession.status.in_(LIVE_STATUSES), GameSession.started_at >= since)
            .order_by(GameSession.started_at.desc())
        )
    )
