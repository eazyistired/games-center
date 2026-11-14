"""Friends write the words: a session can collect words from players' phones before it starts.

collecting (one phone) / lobby (multi-phone) -> players add words (each sees only their own)
-> host starts -> the words become a hidden deck used by the game -> afterwards anyone can
save it as a normal custom deck.
"""

from __future__ import annotations

import re
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import Deck, Device, GameSession, Player, SessionWord, Word
from .decks import clean_word
from .registry import deck_game, get_manifest

SESSION_DECK_PREFIX = "session:"


class CollectError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def is_collecting(s: GameSession) -> bool:
    return bool((s.settings or {}).get("collect_words"))


def per_player(s: GameSession) -> int:
    return int((s.settings or {}).get("collect_per_player") or 5)


def min_total(s: GameSession) -> int:
    rounds = int((s.settings or {}).get("rounds") or 0) if s.game_id == "imposter" else 0
    return max(4, len(s.participants), rounds)


def _my_player(db: Session, device_id: str | None) -> int | None:
    dev = db.get(Device, device_id) if device_id else None
    return dev.player_id if dev else None


def collect_info(db: Session, s: GameSession, device_id: str | None) -> dict[str, Any]:
    rows = db.scalars(select(SessionWord).where(SessionWord.session_id == s.id)).all()
    counts: dict[int | None, int] = {}
    for w in rows:
        counts[w.player_id] = counts.get(w.player_id, 0) + 1
    lineup = [p.player_id for p in s.participants]
    contributors = lineup + [pid for pid in counts if pid is not None and pid not in lineup]
    players = {p.id: p for p in db.scalars(select(Player).where(Player.id.in_(contributors)))}
    me = _my_player(db, device_id)
    return {
        "per_player": per_player(s),
        "min_total": min_total(s),
        "total": len(rows),
        "ready": len(rows) >= min_total(s),
        "counts": [
            {
                "player_id": pid,
                "name": players[pid].name if pid in players else "?",
                "emoji": players[pid].emoji if pid in players else "🙂",
                "count": counts.get(pid, 0),
                "in_lineup": pid in lineup,
            }
            for pid in contributors
        ],
        # only your own words are ever sent to your phone
        "mine": [
            {"id": w.id, "text": w.text}
            for w in rows
            if w.device_id == device_id or (me and w.player_id == me)
        ],
        "me": me,
    }


def _check_open(s: GameSession) -> None:
    if not is_collecting(s):
        raise CollectError("This game doesn't collect words")
    if s.status not in ("collecting", "lobby"):
        raise CollectError("The game already started: no more words")


def add_words(db: Session, s: GameSession, device_id: str | None, text: str) -> int:
    """Add one or more words (one per line). Returns how many were added."""
    _check_open(s)
    me = _my_player(db, device_id)
    if not device_id or me is None:
        raise CollectError("Tell us who you are first (tap your name)", 403)
    mine = db.scalars(
        select(SessionWord).where(SessionWord.session_id == s.id, SessionWord.player_id == me)
    ).all()
    have = {w.text.lower() for w in mine}
    added = 0
    for line in re.split(r"[\n,;]", text):
        word = clean_word(line)
        if not word or word.lower() in have:
            continue
        if len(mine) + added >= per_player(s):
            if added == 0:
                raise CollectError(f"You've added your {per_player(s)} words")
            break
        db.add(SessionWord(session_id=s.id, player_id=me, device_id=device_id, text=word))
        have.add(word.lower())
        added += 1
    if added == 0:
        raise CollectError("Type a word (you already have that one?)")
    db.flush()
    return added


def delete_word(db: Session, s: GameSession, device_id: str | None, word_id: int) -> None:
    _check_open(s)
    w = db.get(SessionWord, word_id)
    me = _my_player(db, device_id)
    if w is None or w.session_id != s.id or (w.device_id != device_id and w.player_id != me):
        raise CollectError("Not your word", 404)
    db.delete(w)
    db.flush()


def materialize(db: Session, s: GameSession) -> Deck:
    """Turn the collected words into a hidden deck and point the session at it."""
    rows = db.scalars(
        select(SessionWord).where(SessionWord.session_id == s.id).order_by(SessionWord.id)
    ).all()
    if len(rows) < min_total(s):
        raise CollectError(f"Need at least {min_total(s)} words ({len(rows)} so far)")
    deck = Deck(
        slug=f"{SESSION_DECK_PREFIX}{s.id}",
        game_id=deck_game(s.game_id),
        name=f"Friends' words · {s.night.date.isoformat()}",
        emoji="✍️",
        description="Written by the players before the game",
        builtin=False,
        enabled=False,  # hidden until someone saves it
    )
    db.add(deck)
    db.flush()
    seen: set[str] = set()
    for w in rows:  # the same word from two people counts once
        if w.text.lower() in seen:
            continue
        seen.add(w.text.lower())
        deck.words.append(Word(text=w.text, active=True, author_player_id=w.player_id))
    s.settings = {**(s.settings or {}), "collected_deck": deck.id, "decks": [deck.id]}
    db.flush()
    return deck


def begin(db: Session, s: GameSession, device_id: str | None) -> None:
    """One-phone game: the host (the phone that created it) starts after collecting."""
    if s.status != "collecting":
        raise CollectError(f"Game is {s.status}")
    if s.controller_device_id and s.controller_device_id != device_id:
        raise CollectError("Only the phone that created the game can start it", 403)
    materialize(db, s)
    s.status = "active"
    db.flush()


def collected_deck(db: Session, s: GameSession) -> Deck | None:
    deck_id = (s.settings or {}).get("collected_deck")
    return db.get(Deck, deck_id) if deck_id else None


def deck_info(db: Session, s: GameSession) -> dict[str, Any] | None:
    deck = collected_deck(db, s)
    if deck is None:
        return None
    return {
        "id": deck.id,
        "name": deck.name,
        "saved": not deck.slug.startswith(SESSION_DECK_PREFIX),
        "count": db.scalar(select(func.count()).select_from(Word).where(Word.deck_id == deck.id)),
    }


def save_deck(db: Session, s: GameSession, name: str, emoji: str | None = None) -> Deck:
    deck = collected_deck(db, s)
    if deck is None:
        raise CollectError("This game has no friends' words to save", 404)
    if s.status in ("collecting", "lobby"):
        raise CollectError("Play the game first")
    name = " ".join(str(name).split())[:60]
    if not name:
        raise CollectError("Give the deck a name")
    if deck.slug.startswith(SESSION_DECK_PREFIX):
        base = "".join(c if c.isalnum() else "-" for c in name.lower()).strip("-") or "deck"
        slug, n = f"custom:{deck.game_id}:{base}", 1
        while db.scalars(select(Deck).where(Deck.slug == slug)).first():
            n += 1
            slug = f"custom:{deck.game_id}:{base}-{n}"
        deck.slug = slug
    deck.name = name
    if emoji:
        deck.emoji = emoji[:16]
    deck.enabled = True
    deck.description = f"Friends' words from {s.night.date.isoformat()} ({(get_manifest(s.game_id) or {}).get('name', s.game_id)})"
    db.flush()
    return deck
