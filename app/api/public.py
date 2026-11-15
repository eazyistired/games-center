"""Player-facing API (no login)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from .. import __version__
from ..config import get_settings
from ..models import LIVE_STATUSES, Crew, Deck, Game, GameNight, GameSession, Player, utcnow
from ..realtime import hub
from ..services import certs, collect, funstats, identity, live, multi
from ..services import leaderboards as lb
from ..services.decks import deck_out, words_for_session
from ..services.nights import current_night_date
from ..services.registry import deck_game, get_manifest, merged_settings
from ..services.runtime import get_runtime
from ..services.sessions import (
    SessionError,
    active_sessions,
    create_session,
    iso,
    recent_lineups,
    session_out,
    submit_result,
)
from .deps import DB, DeviceId, bad_request, get_session_or_404

router = APIRouter(prefix="/api", tags=["public"])


# ---------------------------------------------------------------- meta


@router.get("/health")
def health(db: DB) -> dict[str, Any]:
    db.execute(select(1))
    s = get_settings()
    return {"status": "ok", "version": __version__, "build": s.build_sha, "built": s.build_date}


@router.get("/config")
def config(db: DB) -> dict[str, Any]:
    rt = get_runtime(db)
    settings = get_settings()
    return {
        "build": {"sha": settings.build_sha, "date": settings.build_date},
        "site_name": rt["site_name"],
        "tonight": current_night_date(db).isoformat(),
        "min_sessions": rt["min_sessions"],
        "admin_enabled": bool(get_settings().admin_password),
        "version": __version__,
    }


# ---------------------------------------------------------------- players & crews


def player_dict(p: Player) -> dict[str, Any]:
    return {"id": p.id, "name": p.name, "emoji": p.emoji, "active": p.active}


@router.get("/players")
def list_players(db: DB, device: DeviceId, include_archived: bool = False) -> list[dict[str, Any]]:
    q = select(Player).order_by(func.lower(Player.name))
    if not include_archived:
        q = q.where(Player.active)
    in_use = identity.names_in_use(db, exclude=device)  # on another phone, used recently
    return [player_dict(p) | {"in_use": p.id in in_use} for p in db.scalars(q)]


@router.get("/players/{player_id}/profile")
def player_profile(db: DB, player_id: int) -> dict[str, Any]:
    p = db.get(Player, player_id)
    if p is None:
        raise HTTPException(404, "Player not found")
    rows = lb.fetch_rows(db, player_id=player_id)
    players = {p.id: p}
    overall = lb.aggregate(rows, players)
    per_game = []
    for game_id in sorted({r["game_id"] for r in rows}):
        entry = lb.aggregate([r for r in rows if r["game_id"] == game_id], players)[0]
        m = get_manifest(game_id) or {}
        entry["game"] = {
            "id": game_id,
            "name": m.get("name", game_id),
            "emoji": m.get("emoji", "🎲"),
        }
        per_game.append(entry)
    per_game.sort(key=lambda e: -e["sessions"])
    recent = []
    for r in rows[:25]:
        m = get_manifest(r["game_id"]) or {}
        recent.append(
            {
                "session_id": r["session_id"],
                "game": {
                    "id": r["game_id"],
                    "name": m.get("name", r["game_id"]),
                    "emoji": m.get("emoji", "🎲"),
                },
                "night_id": r["night_id"],
                "date": iso(r["finished_at"]),
                "score": r["score"],
                "placement": r["placement"],
                "points": r["points"],
            }
        )
    # longest win streak (chronological)
    streak = best = 0
    for r in reversed(rows):
        if r["points"] is None:
            continue
        streak = streak + 1 if r["placement"] == 1 else 0
        best = max(best, streak)
    return {
        "badges": funstats.badges(db, player_id),
        "h2h": funstats.head_to_head(db, player_id),
        "player": player_dict(p),
        "overall": overall[0] if overall else None,
        "per_game": per_game,
        "recent": recent,
        "nights_attended": len({r["night_id"] for r in rows}),
        "best_win_streak": best,
    }


class CrewIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    player_ids: list[int]


@router.get("/crews")
def list_crews(db: DB) -> list[dict[str, Any]]:
    return [
        {"id": c.id, "name": c.name, "player_ids": c.player_ids}
        for c in db.scalars(select(Crew).order_by(func.lower(Crew.name)))
    ]


@router.post("/crews")
def save_crew(db: DB, body: CrewIn) -> dict[str, Any]:
    name = body.name.strip()
    crew = db.scalars(select(Crew).where(Crew.name == name)).first()
    if crew is None:
        crew = Crew(name=name, player_ids=body.player_ids)
        db.add(crew)
    else:
        crew.player_ids = body.player_ids
    db.commit()
    return {"id": crew.id, "name": crew.name, "player_ids": crew.player_ids}


@router.delete("/crews/{crew_id}")
def delete_crew(db: DB, crew_id: int) -> dict[str, bool]:
    crew = db.get(Crew, crew_id)
    if crew:
        db.delete(crew)
        db.commit()
    return {"ok": True}


# ---------------------------------------------------------------- games


def game_dict(db: DB, game: Game, full: bool = False) -> dict[str, Any] | None:
    m = get_manifest(game.id)
    if m is None:
        return None
    out = {
        "id": game.id,
        "name": m["name"],
        "emoji": m["emoji"],
        "description": m["description"],
        "min_players": m["min_players"],
        "max_players": m["max_players"],
        "modes": m["modes"],
        "devices": m.get("devices", ["single"]),
        "teams": m["teams"],
        "scoring": m["scoring"],
        "has_decks": m["has_decks"],
        "enabled": game.enabled,
    }
    if full:
        out["settings_schema"] = m["settings"]
        out["defaults"] = merged_settings(m, game.settings)
        if m["has_decks"]:
            decks = db.scalars(
                select(Deck)
                .where(Deck.game_id == deck_game(game.id), Deck.enabled)
                .order_by(Deck.name)
            )
            out["decks"] = [d for d in (deck_out(db, x) for x in decks) if d["word_count"]]
    return out


@router.get("/games")
def list_games(db: DB) -> list[dict[str, Any]]:
    games = db.scalars(select(Game).where(Game.enabled).order_by(Game.sort_order, Game.id))
    return [g for g in (game_dict(db, x) for x in games) if g]


@router.get("/games/{game_id}")
def get_game(db: DB, game_id: str) -> dict[str, Any]:
    game = db.get(Game, game_id)
    out = game_dict(db, game, full=True) if game else None
    if out is None:
        raise HTTPException(404, "Game not found")
    return out


@router.get("/games/{game_id}/lineups")
def game_lineups(db: DB, game_id: str) -> list[dict[str, Any]]:
    return recent_lineups(db, game_id)


@router.get("/games/{game_id}/ratings")
def game_ratings(db: DB, game_id: str) -> dict[int, float]:
    return lb.ratings(db, game_id)


# ---------------------------------------------------------------- sessions


class TeamIn(BaseModel):
    name: str | None = None
    color: str | None = None
    player_ids: list[int]


class SessionIn(BaseModel):
    game_id: str
    mode: str = "solo"
    player_ids: list[int] = []
    teams: list[TeamIn] | None = None
    settings: dict[str, Any] = {}
    device_mode: str = "single"  # single | multi


@router.post("/sessions")
def start_session(db: DB, body: SessionIn, device: DeviceId) -> dict[str, Any]:
    live.touch_device(db, device)
    try:
        s = create_session(
            db,
            body.game_id,
            body.mode,
            body.player_ids,
            [t.model_dump() for t in body.teams] if body.teams else None,
            body.settings,
            device_id=device,
            device_mode=body.device_mode,
        )
    except SessionError as exc:
        raise bad_request(str(exc)) from exc
    db.commit()
    hub.notify(s.id)
    return full_session(db, s, device)


def full_session(db: DB, s, device: str | None) -> dict[str, Any]:
    return multi.session_payload(db, s, device, hub.online_devices(s.id))


def live_error(exc: live.LiveError) -> HTTPException:
    return HTTPException(exc.status, {"message": str(exc), **exc.info})


@router.get("/sessions/live")
def list_live(db: DB, device: DeviceId) -> list[dict[str, Any]]:
    """Unfinished sessions (playing or paused), newest first."""
    return [full_session(db, s, device) for s in active_sessions(db, hours=24)]


@router.get("/sessions/active", include_in_schema=False)
def list_active(db: DB, device: DeviceId) -> list[dict[str, Any]]:
    return list_live(db, device)


@router.get("/sessions/{session_id}")
def get_session(db: DB, session_id: int, device: DeviceId) -> dict[str, Any]:
    return full_session(db, get_session_or_404(db, session_id), device)


class ProgressIn(BaseModel):
    state: dict[str, Any] | None
    version: int | None = None  # the version this state was based on (optimistic locking)
    partial: dict[str, Any] | None = None  # {scores, details}: used if the session goes idle


@router.put("/sessions/{session_id}/progress")
def save_progress(db: DB, session_id: int, body: ProgressIn, device: DeviceId) -> dict[str, Any]:
    s = get_session_or_404(db, session_id)
    if s.status != "active":
        raise bad_request(f"Session is {s.status}")
    try:
        live.require_control(s, device)
    except live.LiveError as exc:
        raise live_error(exc) from exc
    if body.version is not None and body.version != s.state_version:
        raise HTTPException(409, {"message": "Session changed on another phone", "lost": True})
    s.progress = body.state
    if body.partial is not None:
        s.partial_result = body.partial
    s.state_version += 1
    if device:
        s.controller_device_id = device
        s.controller_seen_at = utcnow()
    live.touch_device(db, device)
    db.commit()
    hub.notify(s.id)
    return {"ok": True, "version": s.state_version}


# ---------------------------------------------------------------- live control & takeover


@router.post("/sessions/{session_id}/control")
def claim_control(db: DB, session_id: int, device: DeviceId) -> dict[str, Any]:
    """Become the phone driving this session (if it's free, quiet, or already ours)."""
    s = get_session_or_404(db, session_id)
    live.touch_device(db, device)
    try:
        if s.device_mode == "multi" and multi.seat_of(s, device) is None:
            raise live.LiveError("Join the game first", status=403)
        live.claim_control(db, s, device)
    except live.LiveError as exc:
        db.commit()
        raise live_error(exc) from exc
    db.commit()
    hub.notify(s.id)
    return full_session(db, s, device)


@router.post("/sessions/{session_id}/heartbeat")
def session_heartbeat(db: DB, session_id: int, device: DeviceId) -> dict[str, Any]:
    s = get_session_or_404(db, session_id)
    live.touch_device(db, device)
    out = live.heartbeat(db, s, device)
    db.commit()
    return out


@router.post("/sessions/{session_id}/takeover")
def takeover(db: DB, session_id: int, device: DeviceId) -> dict[str, Any]:
    s = get_session_or_404(db, session_id)
    live.touch_device(db, device)
    if s.device_mode == "multi" and multi.seat_of(s, device) is None:
        raise HTTPException(403, {"message": "Join the game first"})
    try:
        out = live.request_takeover(db, s, device)
    except live.LiveError as exc:
        raise live_error(exc) from exc
    db.commit()
    if out["status"] == "granted":
        hub.notify(s.id)
    return out


@router.get("/sessions/{session_id}/takeover")
def takeover_status(db: DB, session_id: int, device: DeviceId) -> dict[str, Any]:
    s = get_session_or_404(db, session_id)
    live.touch_device(db, device)
    out = live.takeover_status(db, s, device)
    db.commit()
    if out["status"] == "granted":
        hub.notify(s.id)
    return out


@router.delete("/sessions/{session_id}/takeover")
def cancel_takeover(db: DB, session_id: int, device: DeviceId) -> dict[str, bool]:
    live.cancel_takeover(db, get_session_or_404(db, session_id), device)
    db.commit()
    return {"ok": True}


class DecisionIn(BaseModel):
    approve: bool


@router.post("/takeover/{request_id}/decide")
def decide_takeover(db: DB, request_id: int, body: DecisionIn, device: DeviceId) -> dict[str, bool]:
    try:
        live.decide(db, request_id, device, body.approve)
    except live.LiveError as exc:
        raise live_error(exc) from exc
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------- multi-phone: seats, start, act


class SeatIn(BaseModel):
    player_id: int
    force: bool = False  # host only: take the seat from another active phone


def multi_error(exc: multi.MultiError) -> HTTPException:
    return HTTPException(exc.status, {"message": str(exc), **exc.info})


def _multi(db: DB, session_id: int, device: str | None, fn) -> dict[str, Any]:
    s = get_session_or_404(db, session_id)
    live.touch_device(db, device)
    try:
        fn(s)
    except multi.MultiError as exc:
        db.rollback()
        raise multi_error(exc) from exc
    db.commit()
    hub.notify(s.id)
    return full_session(db, s, device)


@router.post("/sessions/{session_id}/seat")
def join_seat(db: DB, session_id: int, body: SeatIn, device: DeviceId) -> dict[str, Any]:
    """Multi-phone: "I'm Ana" - take Ana's seat on this phone."""
    return _multi(
        db,
        session_id,
        device,
        lambda s: multi.claim_seat(
            db, s, device, body.player_id, hub.online_devices(s.id), body.force
        ),
    )


@router.delete("/sessions/{session_id}/seat/{player_id}")
def leave_seat(db: DB, session_id: int, player_id: int, device: DeviceId) -> dict[str, Any]:
    return _multi(db, session_id, device, lambda s: multi.leave_seat(db, s, device, player_id))


class HostIn(BaseModel):
    player_id: int


@router.post("/sessions/{session_id}/host")
def hand_over_host(db: DB, session_id: int, body: HostIn, device: DeviceId) -> dict[str, Any]:
    """Multi-phone: the host gives the 👑 to another joined player."""
    return _multi(
        db, session_id, device, lambda s: multi.transfer_host(db, s, device, body.player_id)
    )


@router.post("/sessions/{session_id}/start")
def start_multi(db: DB, session_id: int, device: DeviceId) -> dict[str, Any]:
    """Multi-phone: the host starts the game once everyone has joined."""
    return _multi(db, session_id, device, lambda s: multi.start(db, s, device))


@router.post("/sessions/{session_id}/act")
def act(db: DB, session_id: int, action: dict[str, Any], device: DeviceId) -> dict[str, Any]:
    """Multi-phone: a player (or host) action, handled by the game's server engine."""
    return _multi(db, session_id, device, lambda s: multi.act(db, s, device, action))


# ---------------------------------------------------------------- friends write the words


class WordsIn(BaseModel):
    text: str


class SaveDeckIn(BaseModel):
    name: str
    emoji: str | None = None


def _collect(db: DB, session_id: int, device: str | None, fn) -> dict[str, Any]:
    s = get_session_or_404(db, session_id)
    live.touch_device(db, device)
    try:
        fn(s)
    except collect.CollectError as exc:
        db.rollback()
        raise HTTPException(exc.status, {"message": str(exc)}) from exc
    db.commit()
    hub.notify(s.id)
    return full_session(db, s, device)


@router.post("/sessions/{session_id}/words")
def add_words(db: DB, session_id: int, body: WordsIn, device: DeviceId) -> dict[str, Any]:
    """Add your own words while the game collects them (one per line)."""
    return _collect(db, session_id, device, lambda s: collect.add_words(db, s, device, body.text))


@router.delete("/sessions/{session_id}/words/{word_id}")
def remove_word(db: DB, session_id: int, word_id: int, device: DeviceId) -> dict[str, Any]:
    return _collect(db, session_id, device, lambda s: collect.delete_word(db, s, device, word_id))


@router.post("/sessions/{session_id}/begin")
def begin_session(db: DB, session_id: int, device: DeviceId) -> dict[str, Any]:
    """One-phone game that collected words: the host starts it."""
    return _collect(db, session_id, device, lambda s: collect.begin(db, s, device))


@router.post("/sessions/{session_id}/save-deck")
def save_collected_deck(
    db: DB, session_id: int, body: SaveDeckIn, device: DeviceId
) -> dict[str, Any]:
    """After the game: keep the friends' words as a normal custom deck."""
    return _collect(
        db, session_id, device, lambda s: collect.save_deck(db, s, body.name, body.emoji)
    )


# ---------------------------------------------------------------- devices ("who are you?")


class HeartbeatIn(BaseModel):
    label: str | None = None


def device_out(db: DB, device: str | None) -> dict[str, Any]:
    from ..models import Device

    d = db.get(Device, device) if device else None
    return {"id": device, "player": live.player_brief(d)}


@router.post("/devices/heartbeat")
def device_heartbeat(db: DB, device: DeviceId, body: HeartbeatIn | None = None) -> dict[str, Any]:
    """Called by the app every ~15 s: keeps the phone 'active' and returns approvals it owes."""
    if not device:
        raise bad_request("Missing X-Device-Id header")
    live.touch_device(db, device, body.label if body else None)
    out = {
        "device": device_out(db, device),
        "requests": live.pending_for(db, device),
        "heartbeat_ms": live.heartbeat_ms(),
    }
    db.commit()
    return out


class WhoAmI(BaseModel):
    player_id: int | None


def identity_error(exc: identity.IdentityError) -> HTTPException:
    return HTTPException(exc.status, {"message": str(exc), **exc.info})


@router.put("/devices/me")
def set_identity(db: DB, body: WhoAmI, device: DeviceId) -> dict[str, Any]:
    """ "This phone is Ana". One phone per name: if Ana is active on another phone, that phone is
    asked first (status "pending" + request_id to poll)."""
    if not device:
        raise bad_request("Missing X-Device-Id header")
    try:
        out = identity.request_name(db, device, body.player_id)
    except identity.IdentityError as exc:
        db.rollback()
        raise identity_error(exc) from exc
    db.commit()
    if out["status"] == "granted":
        notify_seats(db, device)
    return device_out(db, device) | out


def notify_seats(db: DB, device: str | None) -> None:
    """A name moved: refresh the live games where this phone now holds a seat."""
    from ..models import SessionParticipant

    for sid in set(
        db.scalars(
            select(SessionParticipant.session_id).where(SessionParticipant.device_id == device)
        )
    ):
        hub.notify(sid)


@router.get("/identity-requests/{request_id}")
def identity_request_status(db: DB, request_id: int, device: DeviceId) -> dict[str, Any]:
    try:
        out = identity.request_status(db, request_id, device)
    except identity.IdentityError as exc:
        raise identity_error(exc) from exc
    db.commit()
    if out["status"] == "granted":
        notify_seats(db, device)
    return out | {"device": device_out(db, device)}


@router.delete("/identity-requests/{request_id}")
def identity_request_cancel(db: DB, request_id: int, device: DeviceId) -> dict[str, bool]:
    identity.cancel(db, request_id, device)
    db.commit()
    return {"ok": True}


@router.post("/identity-requests/{request_id}/decide")
def identity_request_decide(
    db: DB, request_id: int, body: DecisionIn, device: DeviceId
) -> dict[str, bool]:
    try:
        identity.decide(db, request_id, device, body.approve)
    except identity.IdentityError as exc:
        raise identity_error(exc) from exc
    db.commit()
    notify_seats(db, device)
    return {"ok": True}


# ---------------------------------------------------------------- home certificate (install on phones)


@router.get("/ca")
def ca_info(db: DB) -> dict[str, Any]:
    rt = get_runtime(db)
    return certs.info() | {"app_url": rt["app_url"], "setup_url": rt["setup_url"]}


# ---------------------------------------------------------------- invite QR


@router.get("/qr.svg", include_in_schema=False)
def qr_code(data: str = Query(..., max_length=300)) -> Response:
    import io

    import segno

    buf = io.BytesIO()
    segno.make(data, error="m").save(buf, kind="svg", scale=10, border=2, dark="#000", light="#fff")
    return Response(buf.getvalue(), media_type="image/svg+xml")


@router.get("/sessions/{session_id}/words")
def session_words(db: DB, session_id: int) -> list[dict[str, Any]]:
    return words_for_session(db, get_session_or_404(db, session_id))


class ScoreIn(BaseModel):
    player_id: int | None = None
    team: int | None = None
    score: float | None = None


class WordPlayIn(BaseModel):
    word_id: int
    result: str


class ResultIn(BaseModel):
    scores: list[ScoreIn]
    details: dict[str, Any] | None = None
    word_plays: list[WordPlayIn] | None = None


@router.post("/sessions/{session_id}/result")
def post_result(db: DB, session_id: int, body: ResultIn, device: DeviceId) -> dict[str, Any]:
    s = get_session_or_404(db, session_id)
    try:
        live.require_control(s, device)
    except live.LiveError as exc:
        raise live_error(exc) from exc
    try:
        submit_result(
            db,
            s,
            [x.model_dump() for x in body.scores],
            body.details,
            [w.model_dump() for w in body.word_plays] if body.word_plays else None,
        )
    except SessionError as exc:
        raise bad_request(str(exc)) from exc
    db.commit()
    hub.notify(s.id)
    return full_session(db, s, device)


@router.post("/sessions/{session_id}/abandon")
def abandon(db: DB, session_id: int, device: DeviceId) -> dict[str, Any]:
    s = get_session_or_404(db, session_id)
    if s.status in ("active", "lobby"):
        if s.controller_device_id != device and live.controller_active(s):
            raise HTTPException(409, {"message": "This game is running on another phone"})
        s.status = "abandoned"
        s.finished_at = None
        db.commit()
        hub.notify(s.id)
    return session_out(s)


# ---------------------------------------------------------------- leaderboards & nights


@router.get("/leaderboards")
def leaderboards(
    db: DB,
    period: str = Query("all", pattern="^(tonight|month|year|all)$"),
    game_id: str | None = None,
) -> dict[str, Any]:
    rt = get_runtime(db)
    min_sessions = 1 if period == "tonight" else rt["min_sessions"]
    if game_id and get_manifest(game_id) is None:
        raise HTTPException(404, "Game not found")
    return {
        "period": period,
        "game_id": game_id,
        "min_sessions": min_sessions,
        "entries": lb.leaderboard(db, period=period, game_id=game_id, min_sessions=min_sessions),
    }


def night_summary(db: DB, night: GameNight) -> dict[str, Any]:
    sessions = db.scalars(
        select(GameSession)
        .where(GameSession.night_id == night.id, GameSession.status == "finished")
        .order_by(GameSession.finished_at)
    ).all()
    player_ids = {p.player_id for s in sessions for p in s.participants}
    games = sorted({s.game_id for s in sessions})
    return {
        "id": night.id,
        "date": night.date.isoformat(),
        "label": night.label,
        "session_count": len(sessions),
        "player_count": len(player_ids),
        "games": [
            {
                "id": g,
                "name": (get_manifest(g) or {}).get("name", g),
                "emoji": (get_manifest(g) or {}).get("emoji", "🎲"),
            }
            for g in games
        ],
    }


@router.get("/nights")
def list_nights(db: DB, limit: int = 60) -> list[dict[str, Any]]:
    nights = db.scalars(
        select(GameNight)
        .where(
            GameNight.id.in_(
                select(GameSession.night_id).where(
                    GameSession.status.in_(["finished", *LIVE_STATUSES])
                )
            )
        )
        .order_by(GameNight.date.desc(), GameNight.id.desc())
        .limit(limit)
    )
    out = []
    for n in nights:
        summary = night_summary(db, n)
        standings = lb.leaderboard(db, night_id=n.id)
        summary["top"] = standings[:3]
        summary["live_count"] = db.scalar(
            select(func.count())
            .select_from(GameSession)
            .where(GameSession.night_id == n.id, GameSession.status.in_(LIVE_STATUSES))
        )
        out.append(summary)
    return out


@router.get("/nights/{night_id}")
def get_night(db: DB, night_id: int, device: DeviceId) -> dict[str, Any]:
    night = db.get(GameNight, night_id)
    if night is None:
        raise HTTPException(404, "Night not found")
    out = night_summary(db, night)
    out["standings"] = lb.leaderboard(db, night_id=night.id)
    sessions = db.scalars(
        select(GameSession)
        .where(
            GameSession.night_id == night.id,
            GameSession.status.in_(["finished", *LIVE_STATUSES]),
        )
        .order_by(GameSession.started_at)
    )
    out["sessions"] = [full_session(db, s, device) for s in sessions]
    out["awards"] = funstats.night_awards(db, night.id)
    return out


@router.get("/hall-of-fame")
def hall_of_fame(db: DB) -> dict[str, Any]:
    return funstats.hall_of_fame(db)


@router.get("/tv")
def tv_board(db: DB, night_id: int | None = None) -> dict[str, Any]:
    """Everything the night scoreboard on the TV shows (tonight unless night_id is given)."""
    rt = get_runtime(db)
    if night_id:
        night = db.get(GameNight, night_id)
        if night is None:
            raise HTTPException(404, "Night not found")
    else:
        night = db.scalars(
            select(GameNight)
            .where(GameNight.date == current_night_date(db))
            .order_by(GameNight.id.desc())
        ).first()
    out: dict[str, Any] = {
        "site_name": rt["site_name"],
        "app_url": rt["app_url"],
        "tonight": current_night_date(db).isoformat(),
    }
    if night is None:
        return out | {
            "night": None,
            "standings": [],
            "awards": [],
            "recent": [],
            "games_played": 0,
            "live": [],
        }
    out |= funstats.night_for_tv(db, night)
    live = db.scalars(
        select(GameSession)
        .where(GameSession.night_id == night.id, GameSession.status.in_(LIVE_STATUSES))
        .order_by(GameSession.started_at.desc())
    )
    out["live"] = [full_session(db, s, None) for s in live]
    return out


@router.get("/sessions/{session_id}/summary")
def session_summary(db: DB, session_id: int, device: DeviceId) -> dict[str, Any]:
    s = get_session_or_404(db, session_id)
    return {
        "session": full_session(db, s, device),
        "night": night_summary(db, s.night),
        "night_standings": lb.leaderboard(db, night_id=s.night_id),
        "night_sessions_for_game": db.scalar(
            select(func.count())
            .select_from(GameSession)
            .where(
                GameSession.night_id == s.night_id,
                GameSession.game_id == s.game_id,
                GameSession.status == "finished",
            )
        ),
    }
