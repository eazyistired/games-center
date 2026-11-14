"""Leaderboard aggregation. Data volumes are tiny (tens of players), so we aggregate in Python."""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import date
from typing import Any

from sqlalchemy import extract, select
from sqlalchemy.orm import Session

from ..models import GameNight, GameSession, Player, SessionParticipant
from .nights import current_night_date
from .registry import get_manifest

PERIODS = ("tonight", "month", "year", "all")


def fetch_rows(
    db: Session,
    period: str = "all",
    game_id: str | None = None,
    night_id: int | None = None,
    player_id: int | None = None,
) -> list[dict[str, Any]]:
    q = (
        select(
            SessionParticipant.session_id,
            SessionParticipant.player_id,
            SessionParticipant.team_idx,
            SessionParticipant.score,
            SessionParticipant.placement,
            SessionParticipant.points,
            GameSession.game_id,
            GameSession.mode,
            GameSession.night_id,
            GameSession.finished_at,
            GameNight.date.label("night_date"),
        )
        .join(GameSession, GameSession.id == SessionParticipant.session_id)
        .join(GameNight, GameNight.id == GameSession.night_id)
        .where(GameSession.status == "finished")
    )
    if game_id:
        q = q.where(GameSession.game_id == game_id)
    if night_id:
        q = q.where(GameSession.night_id == night_id)
    if player_id:
        q = q.where(SessionParticipant.player_id == player_id)
    if period != "all" and not night_id:
        today: date = current_night_date(db)
        if period == "tonight":
            q = q.where(GameNight.date == today)
        elif period == "month":
            q = q.where(extract("year", GameNight.date) == today.year).where(
                extract("month", GameNight.date) == today.month
            )
        elif period == "year":
            q = q.where(extract("year", GameNight.date) == today.year)
    q = q.order_by(GameSession.finished_at.desc())
    return [dict(r._mapping) for r in db.execute(q)]


def _player_map(db: Session) -> dict[int, Player]:
    return {p.id: p for p in db.scalars(select(Player))}


def player_out(p: Player | None, player_id: int) -> dict[str, Any]:
    if p is None:
        return {"id": player_id, "name": f"#{player_id}", "emoji": "❔", "active": False}
    return {"id": p.id, "name": p.name, "emoji": p.emoji, "active": p.active}


def aggregate(
    rows: list[dict[str, Any]], players: dict[int, Player], min_sessions: int = 1
) -> list[dict[str, Any]]:
    stats: dict[int, dict[str, Any]] = defaultdict(
        lambda: {
            "sessions": 0,
            "ranked": 0,
            "wins": 0,
            "podiums": 0,
            "total_points": 0.0,
            "scores": [],
            "games": Counter(),
        }
    )
    higher: dict[str, bool] = {}
    for r in rows:
        s = stats[r["player_id"]]
        s["sessions"] += 1
        s["games"][r["game_id"]] += 1
        if r["score"] is not None:
            s["scores"].append(r["score"])
        if r["points"] is not None:
            s["ranked"] += 1
            s["total_points"] += r["points"]
            if r["placement"] == 1:
                s["wins"] += 1
            if r["placement"] is not None and r["placement"] <= 3:
                s["podiums"] += 1
        if r["game_id"] not in higher:
            m = get_manifest(r["game_id"]) or {}
            higher[r["game_id"]] = m.get("scoring", {}).get("higher_is_better", True)

    single_game = len(higher) == 1
    hib = next(iter(higher.values()), True)
    out = []
    for pid, s in stats.items():
        scores = s["scores"]
        entry = {
            "player": player_out(players.get(pid), pid),
            "sessions": s["sessions"],
            "ranked_sessions": s["ranked"],
            "wins": s["wins"],
            "podiums": s["podiums"],
            "total_points": round(s["total_points"], 1),
            "avg_points": round(s["total_points"] / s["ranked"], 1) if s["ranked"] else None,
            "win_rate": round(100 * s["wins"] / s["ranked"]) if s["ranked"] else None,
            "favorite_game": s["games"].most_common(1)[0][0] if s["games"] else None,
            "qualified": s["ranked"] >= min_sessions,
        }
        if single_game:  # raw scores only make sense within one game
            entry["avg_score"] = round(sum(scores) / len(scores), 1) if scores else None
            entry["best_score"] = (max(scores) if hib else min(scores)) if scores else None
        out.append(entry)

    out.sort(
        key=lambda e: (
            not e["qualified"],
            -(e["avg_points"] or 0),
            -e["wins"],
            -e["sessions"],
            e["player"]["name"].lower(),
        )
    )
    rank = 0
    prev = None
    for i, e in enumerate(out):
        if not e["qualified"]:
            e["rank"] = None
            continue
        key = (e["avg_points"], e["wins"])
        if key != prev:
            rank = i + 1
            prev = key
        e["rank"] = rank
    return out


def leaderboard(
    db: Session,
    period: str = "all",
    game_id: str | None = None,
    night_id: int | None = None,
    min_sessions: int = 1,
) -> list[dict[str, Any]]:
    rows = fetch_rows(db, period=period, game_id=game_id, night_id=night_id)
    return aggregate(rows, _player_map(db), min_sessions)


def ratings(db: Session, game_id: str) -> dict[int, float]:
    """Average points per player for a game (falls back to overall) - used to balance teams."""
    players = _player_map(db)
    overall = {e["player"]["id"]: e["avg_points"] for e in aggregate(fetch_rows(db), players)}
    per_game = {
        e["player"]["id"]: e["avg_points"]
        for e in aggregate(fetch_rows(db, game_id=game_id), players)
    }
    out: dict[int, float] = {}
    for pid in set(overall) | set(per_game):
        value = per_game.get(pid)
        if value is None:
            value = overall.get(pid)
        if value is not None:
            out[pid] = value
    return out
