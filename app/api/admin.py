"""Admin API. Everything except status/login requires the admin cookie."""

from __future__ import annotations

import datetime as dt
import json
from datetime import timedelta
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import case, func, select

from .. import auth
from ..config import get_settings
from ..models import (
    AuditLog,
    Crew,
    Deck,
    Game,
    GameNight,
    GameSession,
    Player,
    SessionParticipant,
    Word,
    WordPlay,
    utcnow,
)
from ..services import backup as bk
from ..services.audit import audit
from ..services.decks import clean_word, deck_out, sync_builtin_decks
from ..services.registry import GAMES, deck_game, get_manifest, merged_settings, sync_games
from ..services.runtime import SCORING_FORMULAS, get_runtime, set_runtime
from ..services.scoring import recompute_session
from ..services.sessions import iso, session_out
from .deps import DB, bad_request, get_session_or_404

router = APIRouter(prefix="/api/admin", tags=["admin"])
protected = APIRouter(dependencies=[Depends(auth.require_admin)])


# ---------------------------------------------------------------- auth


class LoginIn(BaseModel):
    password: str


@router.get("/status")
def status(request: Request) -> dict[str, bool]:
    return {"enabled": bool(get_settings().admin_password), "logged_in": auth.is_admin(request)}


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response) -> dict[str, bool]:
    if not get_settings().admin_password:
        raise HTTPException(403, "Admin is disabled: set ADMIN_PASSWORD on the container")
    client = request.client.host if request.client else "?"
    if not auth.check_password(body.password, client):
        raise HTTPException(401, "Wrong password")
    auth.set_admin_cookie(response)
    return {"ok": True}


@router.post("/logout")
def logout(response: Response) -> dict[str, bool]:
    auth.clear_admin_cookie(response)
    return {"ok": True}


# ---------------------------------------------------------------- dashboard


@protected.get("/dashboard")
def dashboard(db: DB) -> dict[str, Any]:
    settings = get_settings()
    count = lambda q: db.scalar(select(func.count()).select_from(q))  # noqa: E731
    finished = select(GameSession).where(GameSession.status == "finished").subquery()
    most_played = db.execute(
        select(GameSession.game_id, func.count())
        .where(GameSession.status == "finished")
        .group_by(GameSession.game_id)
        .order_by(func.count().desc())
    ).all()
    recent = db.scalars(select(GameSession).order_by(GameSession.started_at.desc()).limit(10)).all()
    db_size = settings.db_path.stat().st_size if settings.db_path.exists() else 0
    backups = bk.list_backups(settings)
    return {
        "totals": {
            "players": count(select(Player).where(Player.active).subquery()),
            "archived_players": count(select(Player).where(~Player.active).subquery()),
            "sessions": count(finished),
            "nights": db.scalar(
                select(func.count(func.distinct(GameSession.night_id))).where(
                    GameSession.status == "finished"
                )
            ),
            "words": count(select(Word).where(Word.active).subquery()),
        },
        "most_played": [
            {"game_id": g, "name": (get_manifest(g) or {}).get("name", g), "sessions": n}
            for g, n in most_played
        ],
        "recent_sessions": [session_out(s) for s in recent],
        "db_size": db_size,
        "last_backup": backups[0] if backups else None,
        "backup_count": len(backups),
    }


# ---------------------------------------------------------------- players


class PlayerIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    emoji: str = Field(default="🙂", max_length=16)


class PlayerUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    emoji: str | None = Field(default=None, max_length=16)
    active: bool | None = None


def _name_taken(db: DB, name: str, exclude_id: int | None = None) -> bool:
    q = select(Player).where(func.lower(Player.name) == name.lower())
    if exclude_id:
        q = q.where(Player.id != exclude_id)
    return db.scalars(q).first() is not None


@protected.get("/players")
def admin_players(db: DB) -> list[dict[str, Any]]:
    stats = {
        pid: (n, last)
        for pid, n, last in db.execute(
            select(
                SessionParticipant.player_id,
                func.count(),
                func.max(GameSession.finished_at),
            )
            .join(GameSession, GameSession.id == SessionParticipant.session_id)
            .where(GameSession.status == "finished")
            .group_by(SessionParticipant.player_id)
        )
    }
    out = []
    for p in db.scalars(select(Player).order_by(func.lower(Player.name))):
        n, last = stats.get(p.id, (0, None))
        out.append(
            {
                "id": p.id,
                "name": p.name,
                "emoji": p.emoji,
                "active": p.active,
                "sessions": n,
                "last_played": iso(last),
                "created_at": iso(p.created_at),
            }
        )
    return out


@protected.post("/players")
def add_player(db: DB, body: PlayerIn) -> dict[str, Any]:
    name = " ".join(body.name.split())
    if _name_taken(db, name):
        raise bad_request(f"'{name}' already exists")
    p = Player(name=name, emoji=body.emoji.strip() or "🙂")
    db.add(p)
    db.flush()
    audit(db, "create", "player", p.id, {"name": p.name})
    db.commit()
    return {"id": p.id, "name": p.name, "emoji": p.emoji, "active": p.active}


class BulkIn(BaseModel):
    text: str


@protected.post("/players/bulk")
def bulk_add(db: DB, body: BulkIn) -> dict[str, Any]:
    """One player per line: `Name` or `🦊 Name` or `Name 🦊`."""
    added, skipped = [], []
    for raw in body.text.splitlines():
        line = " ".join(raw.split())
        if not line:
            continue
        parts = line.split(" ")
        emoji = "🙂"
        if len(parts) > 1 and not parts[0][0].isalnum():
            emoji, name = parts[0], " ".join(parts[1:])
        elif len(parts) > 1 and not parts[-1][0].isalnum():
            emoji, name = parts[-1], " ".join(parts[:-1])
        else:
            name = line
        name = name[:60]
        if _name_taken(db, name):
            skipped.append(name)
            continue
        db.add(Player(name=name, emoji=emoji[:16]))
        db.flush()
        added.append(name)
    if added:
        audit(db, "bulk_create", "player", None, {"names": added})
    db.commit()
    return {"added": added, "skipped": skipped}


@protected.put("/players/{player_id}")
def update_player(db: DB, player_id: int, body: PlayerUpdate) -> dict[str, Any]:
    p = db.get(Player, player_id)
    if p is None:
        raise HTTPException(404, "Player not found")
    before = {"name": p.name, "emoji": p.emoji, "active": p.active}
    if body.name is not None:
        name = " ".join(body.name.split())
        if _name_taken(db, name, exclude_id=p.id):
            raise bad_request(f"'{name}' already exists")
        p.name = name
    if body.emoji is not None:
        p.emoji = body.emoji.strip() or "🙂"
    if body.active is not None:
        p.active = body.active
    after = {"name": p.name, "emoji": p.emoji, "active": p.active}
    audit(db, "update", "player", p.id, {"before": before, "after": after})
    db.commit()
    return {"id": p.id, **after}


class MergeIn(BaseModel):
    into_id: int


@protected.post("/players/{player_id}/merge")
def merge_player(db: DB, player_id: int, body: MergeIn) -> dict[str, Any]:
    """Move all history of player_id onto into_id, then delete player_id."""
    src, dst = db.get(Player, player_id), db.get(Player, body.into_id)
    if src is None or dst is None or src.id == dst.id:
        raise bad_request("Pick two different existing players")
    moved = 0
    touched: set[int] = set()
    parts = db.scalars(
        select(SessionParticipant).where(SessionParticipant.player_id == src.id)
    ).all()
    for part in parts:
        clash = db.scalars(
            select(SessionParticipant).where(
                SessionParticipant.session_id == part.session_id,
                SessionParticipant.player_id == dst.id,
            )
        ).first()
        if clash:
            db.delete(part)
        else:
            part.player_id = dst.id
            moved += 1
        touched.add(part.session_id)
    for crew in db.scalars(select(Crew)):
        if src.id in crew.player_ids:
            ids = [dst.id if i == src.id else i for i in crew.player_ids]
            crew.player_ids = list(dict.fromkeys(ids))
    db.flush()
    _recompute_ids(db, touched)
    audit(db, "merge", "player", src.id, {"from": src.name, "into": dst.name, "moved": moved})
    db.delete(src)
    db.commit()
    return {"ok": True, "moved": moved}


@protected.delete("/players/{player_id}")
def delete_player(db: DB, player_id: int) -> dict[str, bool]:
    p = db.get(Player, player_id)
    if p is None:
        raise HTTPException(404, "Player not found")
    used = db.scalar(
        select(func.count())
        .select_from(SessionParticipant)
        .where(SessionParticipant.player_id == p.id)
    )
    if used:
        raise bad_request("This player has history - archive them instead (or merge)")
    audit(db, "delete", "player", p.id, {"name": p.name})
    db.delete(p)
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------- sessions


def _recompute(db: DB, s: GameSession) -> None:
    if s.status != "finished":
        return
    m = get_manifest(s.game_id) or {}
    recompute_session(
        s, m.get("scoring", {}).get("higher_is_better", True), get_runtime(db)["scoring_formula"]
    )


def _recompute_ids(db: DB, ids: set[int]) -> None:
    for sid in ids:
        s = db.get(GameSession, sid)
        if s:
            db.refresh(s)
            _recompute(db, s)


@protected.get("/sessions")
def admin_sessions(
    db: DB,
    game_id: str | None = None,
    night_id: int | None = None,
    player_id: int | None = None,
    status: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    q = select(GameSession)
    if game_id:
        q = q.where(GameSession.game_id == game_id)
    if night_id:
        q = q.where(GameSession.night_id == night_id)
    if status:
        q = q.where(GameSession.status == status)
    if player_id:
        q = q.where(
            GameSession.id.in_(
                select(SessionParticipant.session_id).where(
                    SessionParticipant.player_id == player_id
                )
            )
        )
    total = db.scalar(select(func.count()).select_from(q.subquery()))
    rows = db.scalars(
        q.order_by(GameSession.started_at.desc()).limit(min(limit, 200)).offset(offset)
    )
    return {"total": total, "items": [session_out(s) for s in rows]}


class TeamEdit(BaseModel):
    idx: int
    name: str | None = None
    score: float | None = None


class ParticipantEdit(BaseModel):
    player_id: int
    team_idx: int | None = None
    score: float | None = None


class SessionEdit(BaseModel):
    night_id: int | None = None
    teams: list[TeamEdit] | None = None
    participants: list[ParticipantEdit] | None = None


@protected.put("/sessions/{session_id}")
def edit_session(db: DB, session_id: int, body: SessionEdit) -> dict[str, Any]:
    s = get_session_or_404(db, session_id)
    before = session_out(s)
    if body.night_id is not None:
        if db.get(GameNight, body.night_id) is None:
            raise bad_request("Unknown night")
        s.night_id = body.night_id
    if body.teams is not None and s.mode == "teams":
        by_idx = {t.idx: t for t in s.teams}
        for t in body.teams:
            if t.idx not in by_idx:
                raise bad_request(f"Unknown team {t.idx}")
            if t.name:
                by_idx[t.idx].name = t.name[:40]
            by_idx[t.idx].score = t.score
    if body.participants is not None:
        ids = [p.player_id for p in body.participants]
        if len(set(ids)) != len(ids) or not ids:
            raise bad_request("Participants must be a non-empty list of distinct players")
        known = set(db.scalars(select(Player.id).where(Player.id.in_(ids))))
        if known != set(ids):
            raise bad_request("Unknown player in participants")
        team_idxs = {t.idx for t in s.teams}
        existing = {p.player_id: p for p in s.participants}
        for pe in body.participants:
            if s.mode == "teams" and pe.team_idx not in team_idxs:
                raise bad_request("Every participant needs a valid team")
        for pid, part in existing.items():
            if pid not in ids:
                s.participants.remove(part)
        for pe in body.participants:
            part = existing.get(pe.player_id)
            if part is None:
                part = SessionParticipant(player_id=pe.player_id)
                s.participants.append(part)
            part.team_idx = pe.team_idx if s.mode == "teams" else None
            if s.mode != "teams":
                part.score = pe.score
    db.flush()
    db.refresh(s)
    _recompute(db, s)
    db.flush()
    audit(db, "edit", "session", s.id, {"before": _brief(before), "after": _brief(session_out(s))})
    db.commit()
    return session_out(s)


def _brief(out: dict[str, Any]) -> dict[str, Any]:
    return {
        "night_id": out["night"]["id"],
        "teams": [(t["name"], t["score"]) for t in out["teams"]],
        "participants": [(p["name"], p["team_idx"], p["score"]) for p in out["participants"]],
    }


@protected.post("/sessions/{session_id}/void")
def void_session(db: DB, session_id: int) -> dict[str, Any]:
    s = get_session_or_404(db, session_id)
    if s.status != "finished":
        raise bad_request("Only finished sessions can be voided")
    s.status = "void"
    audit(db, "void", "session", s.id)
    db.commit()
    return session_out(s)


@protected.post("/sessions/{session_id}/restore")
def restore_session(db: DB, session_id: int) -> dict[str, Any]:
    s = get_session_or_404(db, session_id)
    if s.status != "void":
        raise bad_request("Only voided sessions can be restored")
    s.status = "finished"
    _recompute(db, s)
    audit(db, "restore", "session", s.id)
    db.commit()
    return session_out(s)


@protected.delete("/sessions/{session_id}")
def delete_session(db: DB, session_id: int) -> dict[str, bool]:
    s = get_session_or_404(db, session_id)
    audit(db, "delete", "session", s.id, _brief(session_out(s)) | {"status": s.status})
    db.delete(s)
    db.commit()
    return {"ok": True}


@protected.post("/sessions/cleanup")
def cleanup_sessions(db: DB) -> dict[str, int]:
    """Delete abandoned sessions and active ones older than 24h."""
    cutoff = utcnow() - timedelta(hours=24)
    stale = db.scalars(
        select(GameSession).where(
            (GameSession.status == "abandoned")
            | ((GameSession.status == "active") & (GameSession.started_at < cutoff))
        )
    ).all()
    for s in stale:
        db.delete(s)
    audit(db, "cleanup", "session", None, {"deleted": len(stale)})
    db.commit()
    return {"deleted": len(stale)}


# ---------------------------------------------------------------- nights


@protected.get("/nights")
def admin_nights(db: DB) -> list[dict[str, Any]]:
    counts = dict(
        db.execute(
            select(GameSession.night_id, func.count())
            .where(GameSession.status == "finished")
            .group_by(GameSession.night_id)
        ).all()
    )
    all_counts = dict(
        db.execute(select(GameSession.night_id, func.count()).group_by(GameSession.night_id)).all()
    )
    return [
        {
            "id": n.id,
            "date": n.date.isoformat(),
            "label": n.label,
            "sessions": counts.get(n.id, 0),
            "all_sessions": all_counts.get(n.id, 0),
        }
        for n in db.scalars(select(GameNight).order_by(GameNight.date.desc(), GameNight.id.desc()))
    ]


class NightEdit(BaseModel):
    label: str | None = None
    date: dt.date | None = None


@protected.put("/nights/{night_id}")
def edit_night(db: DB, night_id: int, body: NightEdit) -> dict[str, Any]:
    n = db.get(GameNight, night_id)
    if n is None:
        raise HTTPException(404, "Night not found")
    if body.label is not None:
        n.label = body.label.strip()[:100] or None
    if body.date is not None:
        n.date = body.date
    audit(db, "edit", "night", n.id, {"label": n.label, "date": n.date.isoformat()})
    db.commit()
    return {"id": n.id, "date": n.date.isoformat(), "label": n.label}


@protected.post("/nights")
def create_night(db: DB, body: NightEdit) -> dict[str, Any]:
    n = GameNight(date=body.date or dt.date.today(), label=(body.label or "").strip() or None)
    db.add(n)
    db.flush()
    audit(db, "create", "night", n.id)
    db.commit()
    return {"id": n.id, "date": n.date.isoformat(), "label": n.label}


@protected.post("/nights/{night_id}/merge")
def merge_night(db: DB, night_id: int, body: MergeIn) -> dict[str, Any]:
    src, dst = db.get(GameNight, night_id), db.get(GameNight, body.into_id)
    if src is None or dst is None or src.id == dst.id:
        raise bad_request("Pick two different nights")
    sessions = db.scalars(select(GameSession).where(GameSession.night_id == src.id)).all()
    for s in sessions:
        s.night_id = dst.id
    db.flush()
    audit(db, "merge", "night", src.id, {"into": dst.id, "sessions": len(sessions)})
    db.delete(src)
    db.commit()
    return {"ok": True, "moved": len(sessions)}


@protected.delete("/nights/{night_id}")
def delete_night(db: DB, night_id: int) -> dict[str, bool]:
    n = db.get(GameNight, night_id)
    if n is None:
        raise HTTPException(404, "Night not found")
    if db.scalar(select(func.count()).select_from(GameSession).where(GameSession.night_id == n.id)):
        raise bad_request("Night still has sessions - merge it or move them first")
    audit(db, "delete", "night", n.id)
    db.delete(n)
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------- games


@protected.get("/games")
def admin_games(db: DB) -> list[dict[str, Any]]:
    counts = dict(
        db.execute(
            select(GameSession.game_id, func.count())
            .where(GameSession.status == "finished")
            .group_by(GameSession.game_id)
        ).all()
    )
    out = []
    for g in db.scalars(select(Game).order_by(Game.sort_order, Game.id)):
        m = get_manifest(g.id)
        out.append(
            {
                "id": g.id,
                "installed": m is not None,
                "name": (m or {}).get("name", g.id),
                "emoji": (m or {}).get("emoji", "❔"),
                "description": (m or {}).get("description", ""),
                "enabled": g.enabled,
                "sort_order": g.sort_order,
                "settings_schema": (m or {}).get("settings", []),
                "admin_settings": g.settings,
                "defaults": merged_settings(m, g.settings) if m else {},
                "has_decks": (m or {}).get("has_decks", False),
                "deck_source": (m or {}).get("deck_source"),
                "sessions": counts.get(g.id, 0),
            }
        )
    return out


class GameEdit(BaseModel):
    enabled: bool | None = None
    settings: dict[str, Any] | None = None


@protected.put("/games/{game_id}")
def edit_game(db: DB, game_id: str, body: GameEdit) -> dict[str, Any]:
    g = db.get(Game, game_id)
    if g is None:
        raise HTTPException(404, "Game not found")
    if body.enabled is not None:
        g.enabled = body.enabled
    if body.settings is not None:
        m = get_manifest(game_id) or {"settings": []}
        keys = {s["key"] for s in m["settings"]}
        g.settings = {k: v for k, v in body.settings.items() if k in keys}
    audit(db, "edit", "game", g.id, {"enabled": g.enabled, "settings": g.settings})
    db.commit()
    return {"ok": True}


class OrderIn(BaseModel):
    ids: list[str]


@protected.post("/games/order")
def order_games(db: DB, body: OrderIn) -> dict[str, bool]:
    for i, gid in enumerate(body.ids):
        g = db.get(Game, gid)
        if g:
            g.sort_order = i
    db.commit()
    return {"ok": True}


@protected.post("/games/reload")
def reload_games(db: DB) -> dict[str, Any]:
    """Re-read manifests and built-in decks from disk."""
    from ..services.registry import load_manifests

    settings = get_settings()
    load_manifests(settings.games_dir)
    sync_games(db)
    sync_builtin_decks(db, settings.games_dir)
    db.commit()
    return {"games": list(GAMES)}


# ---------------------------------------------------------------- decks & words


class DeckIn(BaseModel):
    game_id: str
    name: str = Field(min_length=1, max_length=60)
    emoji: str = Field(default="🃏", max_length=16)
    description: str = Field(default="", max_length=200)
    words: str = ""


class DeckEdit(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    emoji: str | None = Field(default=None, max_length=16)
    description: str | None = Field(default=None, max_length=200)
    enabled: bool | None = None


def _get_deck(db: DB, deck_id: int) -> Deck:
    d = db.get(Deck, deck_id)
    if d is None:
        raise HTTPException(404, "Deck not found")
    return d


def _add_words(deck: Deck, text: str) -> int:
    existing = {w.text.lower(): w for w in deck.words}
    added = 0
    # one word per line; a single line may also be comma-separated
    lines = text.splitlines() if "\n" in text.strip() else text.split(",")
    for line in lines:
        word = clean_word(line)
        if not word:
            continue
        if word.lower() in existing:
            existing[word.lower()].active = True
            continue
        w = Word(text=word, active=True)
        deck.words.append(w)
        existing[word.lower()] = w
        added += 1
    return added


@protected.get("/decks")
def admin_decks(db: DB, game_id: str | None = None) -> list[dict[str, Any]]:
    q = select(Deck).order_by(Deck.builtin.desc(), Deck.name)
    if game_id:
        q = q.where(Deck.game_id == game_id)
    return [deck_out(db, d) for d in db.scalars(q)]


@protected.post("/decks")
def create_deck(db: DB, body: DeckIn) -> dict[str, Any]:
    m = get_manifest(body.game_id)
    if not m or not m.get("has_decks"):
        raise bad_request("That game doesn't use decks")
    body.game_id = deck_game(body.game_id)  # games sharing decks store them on the source game
    base = "".join(c if c.isalnum() else "-" for c in body.name.lower()).strip("-") or "deck"
    slug, n = f"custom:{body.game_id}:{base}", 1
    while db.scalars(select(Deck).where(Deck.slug == slug)).first():
        n += 1
        slug = f"custom:{body.game_id}:{base}-{n}"
    d = Deck(
        slug=slug,
        game_id=body.game_id,
        name=body.name.strip(),
        emoji=body.emoji or "🃏",
        description=body.description.strip(),
        builtin=False,
        enabled=True,
    )
    db.add(d)
    db.flush()
    _add_words(d, body.words)
    audit(db, "create", "deck", d.id, {"name": d.name})
    db.commit()
    return deck_out(db, d, with_words=True)


@protected.get("/decks/{deck_id}")
def get_deck(db: DB, deck_id: int) -> dict[str, Any]:
    return deck_out(db, _get_deck(db, deck_id), with_words=True)


@protected.put("/decks/{deck_id}")
def edit_deck(db: DB, deck_id: int, body: DeckEdit) -> dict[str, Any]:
    d = _get_deck(db, deck_id)
    if body.enabled is not None:
        d.enabled = body.enabled
    if not d.builtin:
        if body.name is not None:
            d.name = body.name.strip()
        if body.emoji is not None:
            d.emoji = body.emoji or "🃏"
        if body.description is not None:
            d.description = body.description.strip()
    audit(db, "edit", "deck", d.id, {"name": d.name, "enabled": d.enabled})
    db.commit()
    return deck_out(db, d)


@protected.delete("/decks/{deck_id}")
def delete_deck(db: DB, deck_id: int) -> dict[str, bool]:
    d = _get_deck(db, deck_id)
    if d.builtin:
        raise bad_request("Built-in decks can't be deleted - disable them instead")
    audit(db, "delete", "deck", d.id, {"name": d.name, "words": len(d.words)})
    db.delete(d)
    db.commit()
    return {"ok": True}


class WordsIn(BaseModel):
    text: str


@protected.post("/decks/{deck_id}/words")
def add_words(db: DB, deck_id: int, body: WordsIn) -> dict[str, Any]:
    d = _get_deck(db, deck_id)
    if d.builtin:
        raise bad_request("Built-in decks are edited in the repo; create a custom deck instead")
    added = _add_words(d, body.text)
    audit(db, "add_words", "deck", d.id, {"added": added})
    db.commit()
    return {"added": added, "deck": deck_out(db, d, with_words=True)}


class WordEdit(BaseModel):
    text: str | None = None
    active: bool | None = None


@protected.put("/words/{word_id}")
def edit_word(db: DB, word_id: int, body: WordEdit) -> dict[str, Any]:
    w = db.get(Word, word_id)
    if w is None:
        raise HTTPException(404, "Word not found")
    deck = db.get(Deck, w.deck_id)
    if body.active is not None:
        w.active = body.active
    if body.text is not None:
        if deck and deck.builtin:
            raise bad_request("Built-in words can only be enabled/disabled")
        text = clean_word(body.text)
        if not text:
            raise bad_request("Word can't be empty")
        w.text = text
    db.commit()
    return {"id": w.id, "text": w.text, "active": w.active}


@protected.delete("/words/{word_id}")
def delete_word(db: DB, word_id: int) -> dict[str, bool]:
    w = db.get(Word, word_id)
    if w is None:
        raise HTTPException(404, "Word not found")
    deck = db.get(Deck, w.deck_id)
    if deck and deck.builtin:
        w.active = False
    else:
        db.delete(w)
    db.commit()
    return {"ok": True}


@protected.get("/words/stats")
def hardest_words(db: DB, game_id: str | None = None, limit: int = 30) -> list[dict[str, Any]]:
    q = (
        select(
            Word.id,
            Word.text,
            Deck.name,
            func.count().label("shown"),
            func.sum(case((WordPlay.result == "correct", 1), else_=0)).label("ok"),
        )
        .join(WordPlay, WordPlay.word_id == Word.id)
        .join(Deck, Deck.id == Word.deck_id)
        .join(GameSession, GameSession.id == WordPlay.session_id)
        .where(GameSession.status == "finished")
        .group_by(Word.id)
    )
    if game_id:
        q = q.where(Deck.game_id == game_id)
    rows = []
    for wid, text, deck, shown, ok in db.execute(q):
        ok = int(ok or 0)
        rows.append(
            {
                "id": wid,
                "text": text,
                "deck": deck,
                "shown": shown,
                "correct": ok,
                "passed": shown - ok,
                "correct_rate": round(100 * ok / shown),
            }
        )
    rows.sort(key=lambda r: (r["correct_rate"], -r["shown"]))
    return rows[:limit]


# ---------------------------------------------------------------- settings


@protected.get("/settings")
def get_admin_settings(db: DB) -> dict[str, Any]:
    s = get_settings()
    return {
        "values": get_runtime(db),
        "formulas": SCORING_FORMULAS,
        "environment": {
            "data_dir": str(s.data_dir),
            "backup_keep": s.backup_keep,
            "auto_backup": s.auto_backup,
            "secure_cookies": s.secure_cookies,
        },
    }


@protected.put("/settings")
def put_admin_settings(db: DB, body: dict[str, Any]) -> dict[str, Any]:
    before = get_runtime(db)
    try:
        values = set_runtime(db, body)
    except ValueError as exc:
        raise bad_request(str(exc)) from exc
    audit(db, "edit", "settings", None, {k: v for k, v in body.items()})
    if values["scoring_formula"] != before["scoring_formula"]:
        _recompute_all(db)
    db.commit()
    return values


def _recompute_all(db: DB) -> int:
    sessions = db.scalars(select(GameSession).where(GameSession.status == "finished")).all()
    for s in sessions:
        _recompute(db, s)
    db.flush()
    return len(sessions)


@protected.post("/recompute")
def recompute_all(db: DB) -> dict[str, int]:
    n = _recompute_all(db)
    audit(db, "recompute", "sessions", None, {"count": n})
    db.commit()
    return {"sessions": n}


# ---------------------------------------------------------------- backups


@protected.get("/backups")
def backups() -> list[dict[str, Any]]:
    return bk.list_backups(get_settings())


@protected.post("/backups")
def backup_now(db: DB) -> dict[str, Any]:
    path = bk.make_backup(get_settings(), "manual")
    audit(db, "backup", "database", None, {"file": path.name})
    db.commit()
    return {"name": path.name}


@protected.get("/backups/{name}")
def download_backup(name: str) -> FileResponse:
    settings = get_settings()
    path = (settings.backups_dir / name).resolve()
    if path.parent != settings.backups_dir.resolve() or not path.is_file():
        raise HTTPException(404, "Backup not found")
    return FileResponse(path, filename=name, media_type="application/x-sqlite3")


@protected.get("/export")
def export(db: DB) -> JSONResponse:
    data = bk.export_json(db)
    stamp = data["exported_at"][:19].replace(":", "").replace("-", "")
    return JSONResponse(
        data, headers={"Content-Disposition": f'attachment; filename="games-center-{stamp}.json"'}
    )


@protected.post("/import")
async def import_data(db: DB, file: UploadFile = File(...)) -> dict[str, Any]:  # noqa: B008
    try:
        data = json.loads(await file.read())
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise bad_request("File is not valid JSON") from exc
    settings = get_settings()
    bk.make_backup(settings, "pre-import")
    try:
        counts = bk.import_json(db, data)
        sync_games(db)
        sync_builtin_decks(db, settings.games_dir)
        audit(db, "import", "database", None, counts)
        db.commit()
    except (ValueError, KeyError, TypeError) as exc:
        db.rollback()
        raise bad_request(f"Import failed: {exc}") from exc
    return {"ok": True, "counts": counts}


# ---------------------------------------------------------------- audit


@protected.get("/audit")
def audit_log(db: DB, limit: int = 100, offset: int = 0) -> dict[str, Any]:
    total = db.scalar(select(func.count()).select_from(AuditLog))
    rows = db.scalars(
        select(AuditLog).order_by(AuditLog.id.desc()).limit(min(limit, 500)).offset(offset)
    )
    return {
        "total": total,
        "items": [
            {
                "id": a.id,
                "at": iso(a.at),
                "action": a.action,
                "entity": a.entity,
                "entity_id": a.entity_id,
                "detail": a.detail,
            }
            for a in rows
        ],
    }


router.include_router(protected)
