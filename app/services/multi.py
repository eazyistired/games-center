"""Multi-phone sessions: lobby & seats, engine actions, per-phone payloads, watch scoreboard."""

from __future__ import annotations

import copy
import threading
from collections import defaultdict
from typing import Any

from sqlalchemy.orm import Session

from ..engines import ActionError, Actor, Ctx, Viewer, get_engine
from ..models import Device, GameSession, SessionParticipant, utcnow
from . import collect, live
from .decks import words_for_session
from .sessions import session_out, submit_result

# one lock per session: engine actions read-modify-write the state
_locks: dict[int, threading.Lock] = defaultdict(threading.Lock)


class MultiError(ValueError):
    def __init__(self, message: str, status: int = 400, info: dict | None = None):
        super().__init__(message)
        self.status = status
        self.info = info or {}


# ---------------------------------------------------------------- helpers


def ctx_for(db: Session, s: GameSession) -> Ctx:
    members: dict[int, list[int]] = {}
    for p in s.participants:
        if p.team_idx is not None:
            members.setdefault(p.team_idx, []).append(p.player_id)

    def draw_words(n: int) -> list[dict[str, Any]]:
        return words_for_session(db, s)[:n]

    return Ctx(
        session_id=s.id,
        mode=s.mode,
        settings=s.settings or {},
        players=[
            {
                "id": p.player_id,
                "name": p.player.name,
                "emoji": p.player.emoji,
                "team_idx": p.team_idx,
            }
            for p in s.participants
        ],
        teams=[
            {"idx": t.idx, "name": t.name, "color": t.color, "player_ids": members.get(t.idx, [])}
            for t in s.teams
        ],
        draw_words=draw_words,
    )


def seat_of(s: GameSession, device_id: str | None) -> SessionParticipant | None:
    if not device_id:
        return None
    return next((p for p in s.participants if p.device_id == device_id), None)


def is_host(s: GameSession, device_id: str | None) -> bool:
    return bool(device_id) and s.controller_device_id == device_id


def _seat_active(db: Session, seat: SessionParticipant, online: set[str]) -> bool:
    if not seat.device_id:
        return False
    if seat.device_id in online:
        return True
    dev = db.get(Device, seat.device_id)
    return dev is not None and live.is_fresh(dev.last_seen)


# ---------------------------------------------------------------- lobby


def lobby_info(db: Session, s: GameSession, device_id: str | None, online: set[str]) -> dict:
    seats = []
    for p in s.participants:
        seats.append(
            {
                "player_id": p.player_id,
                "name": p.player.name,
                "emoji": p.player.emoji,
                "team_idx": p.team_idx,
                "joined": bool(p.device_id),
                "online": bool(p.device_id) and p.device_id in online,
                "mine": bool(device_id) and p.device_id == device_id,
                "host": bool(p.device_id) and p.device_id == s.controller_device_id,
            }
        )
    return {
        "seats": seats,
        "all_joined": all(x["joined"] for x in seats),
        "is_host": is_host(s, device_id),
        "my_seat": next((x["player_id"] for x in seats if x["mine"]), None),
    }


def claim_seat(
    db: Session,
    s: GameSession,
    device_id: str | None,
    player_id: int,
    online: set[str],
    force: bool = False,
) -> None:
    """Take a seat. If another active phone holds it, `force` is only allowed for the host."""
    if not device_id:
        raise MultiError("Missing device id")
    if s.device_mode != "multi" or s.status not in ("lobby", "active"):
        raise MultiError("This game has no seats to join")
    seat = next((p for p in s.participants if p.player_id == player_id), None)
    if seat is None:
        raise MultiError("That player isn't in this game", 404)
    if seat.device_id == device_id:
        return
    if seat.device_id and _seat_active(db, seat, online) and not (force and is_host(s, device_id)):
        raise MultiError(
            f"{seat.player.name} is already playing on another phone",
            409,
            {"seat_taken": True},
        )
    for other in s.participants:  # one seat per phone
        if other.device_id == device_id:
            other.device_id, other.joined_at = None, None
    seat.device_id, seat.joined_at = device_id, utcnow()
    dev = live.touch_device(db, device_id)
    if dev is not None:
        dev.player_id = player_id  # claiming a seat = "this phone is me"
    db.flush()


def leave_seat(db: Session, s: GameSession, device_id: str | None, player_id: int) -> None:
    seat = next((p for p in s.participants if p.player_id == player_id), None)
    if seat is None:
        raise MultiError("That player isn't in this game", 404)
    if seat.device_id != device_id and not is_host(s, device_id):
        raise MultiError("Only the host can remove someone else", 403)
    seat.device_id, seat.joined_at = None, None
    db.flush()


def start(db: Session, s: GameSession, device_id: str | None) -> None:
    if s.status != "lobby":
        raise MultiError(f"Game already {s.status}")
    if not is_host(s, device_id):
        raise MultiError("Only the host can start the game", 403)
    missing = [p.player.name for p in s.participants if not p.device_id]
    if missing:
        raise MultiError(f"Waiting for: {', '.join(missing)}")
    engine = get_engine(s.game_id)
    if engine is None:
        raise MultiError("This game can't be played on multiple phones")
    if collect.is_collecting(s):
        try:
            collect.materialize(db, s)
        except collect.CollectError as exc:
            raise MultiError(str(exc)) from exc
    s.progress = engine.setup(ctx_for(db, s))
    s.status = "active"
    s.state_version += 1
    s.controller_seen_at = utcnow()
    db.flush()


# ---------------------------------------------------------------- actions


def act(db: Session, s: GameSession, device_id: str | None, action: dict) -> None:
    if s.device_mode != "multi" or s.status != "active":
        raise MultiError("This game isn't running")
    engine = get_engine(s.game_id)
    if engine is None:
        raise MultiError("No engine for this game")
    seat = seat_of(s, device_id)
    host = is_host(s, device_id)
    if seat is None and not host:
        raise MultiError("Join the game first", 403)
    with _locks[s.id]:
        db.refresh(s)
        ctx = ctx_for(db, s)
        try:
            state = engine.act(
                copy.deepcopy(s.progress or {}),
                ctx,
                Actor(seat.player_id if seat else None, host),
                action,
            )
        except ActionError as exc:
            raise MultiError(str(exc)) from exc
        s.progress = state
        s.state_version += 1
        s.partial_result = engine.partial(state, ctx)
        if host:
            s.controller_seen_at = utcnow()
        result = engine.result(state, ctx)
        if result is not None:
            submit_result(
                db, s, result.get("scores", []), result.get("details"), result.get("word_plays")
            )
        db.flush()


# ---------------------------------------------------------------- payloads


def watch_info(db: Session, s: GameSession) -> dict[str, Any]:
    """Public info for spectators / TV: headline + scoreboard."""
    if s.device_mode == "multi" and s.status == "active":
        engine = get_engine(s.game_id)
        if engine:
            v = engine.view(copy.deepcopy(s.progress or {}), ctx_for(db, s), Viewer(None))
            return {"headline": v.get("headline"), "scoreboard": v.get("scoreboard") or []}
    names = {p.player_id: p.player for p in s.participants}
    teams = {t.idx: t for t in s.teams}
    if s.status == "finished":
        rows = (
            [{"name": t.name, "emoji": "", "score": t.score, "color": t.color} for t in s.teams]
            if s.mode == "teams"
            else [
                {"name": p.player.name, "emoji": p.player.emoji, "score": p.score}
                for p in s.participants
            ]
        )
        return {"headline": (s.details or {}).get("summary"), "scoreboard": rows}
    partial = s.partial_result or {}
    rows = []
    for e in partial.get("scores", []):
        if "team" in e and e["team"] in teams:
            t = teams[e["team"]]
            rows.append({"name": t.name, "emoji": "", "score": e.get("score"), "color": t.color})
        elif e.get("player_id") in names:
            p = names[e["player_id"]]
            rows.append({"name": p.name, "emoji": p.emoji, "score": e.get("score")})
    return {"headline": (partial.get("details") or {}).get("summary"), "scoreboard": rows}


def session_payload(db: Session, s: GameSession, device_id: str | None, online: set[str]) -> dict:
    """Everything one phone may know about a session (used by HTTP and WebSocket)."""
    out = session_out(s) | live.live_info(db, s, device_id)
    out["watch"] = watch_info(db, s)
    if collect.is_collecting(s):
        if s.status in ("collecting", "lobby"):
            out["collect"] = collect.collect_info(db, s, device_id)
        out["collected_deck"] = collect.deck_info(db, s)
    if s.device_mode == "multi":
        out["progress"] = None  # engine state is secret: phones only get their own view
        out["lobby"] = lobby_info(db, s, device_id, online)
        engine = get_engine(s.game_id)
        if engine and s.status == "active":
            seat = seat_of(s, device_id)
            out["view"] = engine.view(
                copy.deepcopy(s.progress or {}),
                ctx_for(db, s),
                Viewer(seat.player_id if seat else None, is_host(s, device_id)),
            )
    return out
