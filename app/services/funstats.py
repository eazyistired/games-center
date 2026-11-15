"""Fun stats: night awards, badges, head-to-head, best teammate, hall of fame.

Everything is derived from finished sessions (participants + the games' `details`), so history
that was played before these stats existed counts too.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import GameNight, GameSession, Player
from .leaderboards import aggregate, fetch_rows, player_out
from .registry import GAMES
from .runtime import get_runtime


def _players(db: Session) -> dict[int, Player]:
    return {p.id: p for p in db.scalars(select(Player))}


def _sessions(
    db: Session, night_id: int | None = None, player_id: int | None = None
) -> list[GameSession]:
    q = (
        select(GameSession)
        .where(GameSession.status == "finished")
        .order_by(GameSession.finished_at)
    )
    if night_id:
        q = q.where(GameSession.night_id == night_id)
    sessions = list(db.scalars(q))
    if player_id:
        sessions = [s for s in sessions if any(p.player_id == player_id for p in s.participants)]
    return sessions


# ---------------------------------------------------------------- game-specific counters


def _game_counters(sessions: list[GameSession]) -> dict[str, Counter]:
    """words (Heads Up guesser / Three Rounds clue-giver), bullseyes (Tuned In clue-giver),
    escapes (Imposter not caught)."""
    words, bulls, escapes, minds = Counter(), Counter(), Counter(), Counter()
    for s in sessions:
        d = s.details or {}
        if s.game_id in ("heads-up", "three-rounds"):
            for pid, n in (d.get("per_player") or {}).items():
                words[int(pid)] += int(n or 0)
        elif s.game_id == "tuned-in":
            for t in d.get("turns") or []:
                if t.get("points") == 4 and t.get("player_id") is not None:
                    bulls[int(t["player_id"])] += 1
        elif s.game_id == "popular-opinion":
            for r in d.get("rounds") or []:
                for pid, n in (r.get("points") or {}).items():
                    minds[int(pid)] += int(n or 0)
        elif s.game_id == "imposter":
            for r in d.get("rounds") or []:
                for imp in r.get("imposters") or []:
                    if imp not in (r.get("accused") or []):
                        escapes[int(imp)] += 1
    return {"words": words, "bulls": bulls, "escapes": escapes, "minds": minds}


# ---------------------------------------------------------------- night awards

AWARDS = [
    ("mvp", "🏆", "MVP", "Most points tonight"),
    ("wins", "🥇", "Most wins", "Won the most games"),
    ("words", "🗣️", "Wordsmith", "Most words in Heads Up & Three Rounds"),
    ("bulls", "🎯", "Sharpshooter", "Most bullseyes in Tuned In"),
    ("escapes", "🕵️", "Master of disguise", "Got away as the imposter most often"),
    ("minds", "🧠", "Mind reader", "Read the room best in Popular Opinion"),
    ("seconds", "🥈", "Always the bridesmaid", "Most second places"),
    ("sport", "🤝", "Good sport", "Most games played without a win"),
]


def night_awards(db: Session, night_id: int) -> list[dict[str, Any]]:
    sessions = _sessions(db, night_id=night_id)
    if not sessions:
        return []
    players = _players(db)
    points, wins, seconds, games = Counter(), Counter(), Counter(), Counter()
    for s in sessions:
        for p in s.participants:
            games[p.player_id] += 1
            if p.points is not None:
                points[p.player_id] += p.points
                if p.placement == 1:
                    wins[p.player_id] += 1
                elif p.placement == 2:
                    seconds[p.player_id] += 1
    sport = Counter({pid: n for pid, n in games.items() if wins[pid] == 0 and n >= 2})
    counters = {
        "mvp": points,
        "wins": wins,
        "seconds": seconds,
        "sport": sport,
        **_game_counters(sessions),
    }
    out = []
    for key, emoji, title, desc in AWARDS:
        c = counters[key]
        if not c:
            continue
        best = max(c.values())
        if best <= 0 or (key == "seconds" and best < 2):
            continue
        winners = [pid for pid, v in c.items() if v == best]
        out.append(
            {
                "key": key,
                "emoji": emoji,
                "title": title,
                "description": desc,
                "players": [player_out(players.get(pid), pid) for pid in winners],
                "value": round(best, 1),
            }
        )
    return out


# ---------------------------------------------------------------- per-player fun


def head_to_head(db: Session, player_id: int) -> dict[str, Any]:
    players = _players(db)
    rec: dict[int, Counter] = defaultdict(Counter)
    duo: dict[int, Counter] = defaultdict(Counter)
    for s in _sessions(db, player_id=player_id):
        me = next(p for p in s.participants if p.player_id == player_id)
        if me.placement is None or me.points is None:
            continue
        for o in s.participants:
            if o.player_id == player_id:
                continue
            if s.mode == "teams" and o.team_idx == me.team_idx:
                duo[o.player_id]["games"] += 1
                duo[o.player_id]["wins"] += me.placement == 1
                continue
            r = rec[o.player_id]
            r["games"] += 1
            if me.placement < o.placement:
                r["wins"] += 1
            elif me.placement > o.placement:
                r["losses"] += 1
            else:
                r["ties"] += 1
    rows = [
        {
            "player": player_out(players.get(pid), pid),
            "games": c["games"],
            "wins": c["wins"],
            "losses": c["losses"],
            "ties": c["ties"],
        }
        for pid, c in rec.items()
    ]
    rows.sort(key=lambda r: (-r["games"], -r["wins"]))
    enough = [r for r in rows if r["games"] >= 3]
    nemesis = max(enough, key=lambda r: (r["losses"] / r["games"], r["losses"]), default=None)
    victim = max(enough, key=lambda r: (r["wins"] / r["games"], r["wins"]), default=None)
    partners = [
        {
            "player": player_out(players.get(pid), pid),
            "games": c["games"],
            "wins": c["wins"],
            "win_rate": round(100 * c["wins"] / c["games"]),
        }
        for pid, c in duo.items()
        if c["games"] >= 2
    ]
    partners.sort(key=lambda r: (-r["win_rate"], -r["games"]))
    return {
        "rivals": rows,
        "nemesis": nemesis if nemesis and nemesis["losses"] else None,
        "victim": victim if victim and victim["wins"] else None,
        "best_teammate": partners[0] if partners else None,
        "teammates": partners,
    }


def _month_champions(db: Session) -> list[dict[str, Any]]:
    """Winner of each finished month (avg points, min games from the settings)."""
    players = _players(db)
    rows = fetch_rows(db)
    min_sessions = get_runtime(db)["min_sessions"]
    by_month: dict[str, list] = defaultdict(list)
    for r in rows:
        nd: date = r["night_date"]
        by_month[f"{nd.year}-{nd.month:02d}"].append(r)
    out = []
    for month in sorted(by_month, reverse=True):
        board = [e for e in aggregate(by_month[month], players, min_sessions) if e["qualified"]]
        if board:
            out.append(
                {
                    "month": month,
                    "champion": board[0]["player"],
                    "avg_points": board[0]["avg_points"],
                    "sessions": board[0]["sessions"],
                    "runner_up": board[1]["player"] if len(board) > 1 else None,
                }
            )
    return out


def hall_of_fame(db: Session) -> dict[str, Any]:
    champs = _month_champions(db)
    titles = Counter(c["champion"]["id"] for c in champs)
    players = _players(db)
    return {
        "months": champs,
        "most_titles": [
            {"player": player_out(players.get(pid), pid), "titles": n}
            for pid, n in titles.most_common(5)
        ],
    }


def badges(db: Session, player_id: int) -> list[dict[str, Any]]:
    sessions = _sessions(db, player_id=player_id)
    mine = [next(p for p in s.participants if p.player_id == player_id) for s in sessions]
    ranked = [(s, p) for s, p in zip(sessions, mine, strict=True) if p.points is not None]
    wins = sum(1 for _, p in ranked if p.placement == 1)
    seconds = sum(1 for _, p in ranked if p.placement == 2)
    streak = best_streak = 0
    for _, p in ranked:
        streak = streak + 1 if p.placement == 1 else 0
        best_streak = max(best_streak, streak)
    c = _game_counters(sessions)
    nights = len({s.night_id for s in sessions})
    played = {s.game_id for s in sessions}
    all_games = set(GAMES)
    month_titles = sum(1 for m in _month_champions(db) if m["champion"]["id"] == player_id)

    def b(key, emoji, title, desc, value, goal):
        return {
            "key": key,
            "emoji": emoji,
            "title": title,
            "description": desc,
            "earned": value >= goal,
            "progress": min(value, goal),
            "goal": goal,
        }

    return [
        b("first_win", "🏅", "First win", "Win a game", wins, 1),
        b("streak", "🔥", "Hot streak", "Win 3 games in a row", best_streak, 3),
        b("bridesmaid", "🥈", "Bridesmaid", "Finish second 5 times", seconds, 5),
        b("bullseye", "🎯", "Bullseye", "Hit a bullseye in Tuned In", c["bulls"][player_id], 1),
        b(
            "escape",
            "🕵️",
            "Escape artist",
            "Get away as the imposter 3 times",
            c["escapes"][player_id],
            3,
        ),
        b(
            "wordsmith",
            "🗣️",
            "Wordsmith",
            "50 words in Heads Up & Three Rounds",
            c["words"][player_id],
            50,
        ),
        b("regular", "🌙", "Regular", "Come to 10 game nights", nights, 10),
        b(
            "all_rounder",
            "🎲",
            "All-rounder",
            "Play every game",
            len(played & all_games),
            max(1, len(all_games)),
        ),
        b("centurion", "💯", "Centurion", "Play 100 games", len(sessions), 100),
        b("champion", "👑", "Champion", "Win a month", month_titles, 1),
    ]


# ---------------------------------------------------------------- the TV night board


def night_for_tv(db: Session, night: GameNight) -> dict[str, Any]:
    players = _players(db)
    rows = fetch_rows(db, night_id=night.id)
    standings = aggregate(rows, players, 1)
    standings.sort(key=lambda e: (-e["total_points"], -e["wins"]))
    recent = []
    for s in reversed(_sessions(db, night_id=night.id)[-6:]):
        m = GAMES.get(s.game_id) or {}
        if s.mode == "teams":
            win = [
                {"name": t.name, "emoji": "", "color": t.color} for t in s.teams if t.placement == 1
            ]
        else:
            win = [
                {"name": p.player.name, "emoji": p.player.emoji}
                for p in s.participants
                if p.placement == 1
            ]
        recent.append(
            {
                "id": s.id,
                "game": {"name": m.get("name", s.game_id), "emoji": m.get("emoji", "🎲")},
                "winners": win,
                "finished_at": s.finished_at.isoformat() + "Z" if s.finished_at else None,
            }
        )
    return {
        "night": {"id": night.id, "date": night.date.isoformat(), "label": night.label},
        "standings": standings,
        "awards": night_awards(db, night.id),
        "recent": recent,
        "games_played": len(_sessions(db, night_id=night.id)),
    }
