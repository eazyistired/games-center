"""Word decks: built-in decks live in games/<id>/decks/*.json, custom ones only in the DB."""

from __future__ import annotations

import json
import logging
import random
from pathlib import Path
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import Deck, GameSession, Word, WordPlay
from .registry import GAMES, deck_game

log = logging.getLogger(__name__)


def clean_word(text: str) -> str:
    return " ".join(str(text).split())[:120]


def sync_builtin_decks(db: Session, games_dir: Path) -> None:
    """Insert/refresh built-in decks. Admin word toggles are preserved; words removed
    from a file are deactivated (their stats are kept)."""
    for game_id, manifest in GAMES.items():
        if not manifest.get("has_decks") or manifest.get("deck_source"):
            continue
        for path in sorted((games_dir / game_id / "decks").glob("*.json")):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                log.error("bad deck %s: %s", path, exc)
                continue
            slug = f"{game_id}:{path.stem}"
            deck = db.scalars(select(Deck).where(Deck.slug == slug)).first()
            if deck is None:
                deck = Deck(slug=slug, game_id=game_id, builtin=True, enabled=True, name=path.stem)
                db.add(deck)
            deck.name = data.get("name", path.stem)[:60]
            deck.emoji = data.get("emoji", "🃏")[:16]
            deck.description = data.get("description", "")[:200]
            db.flush()
            file_words = {clean_word(w) for w in data.get("words", []) if clean_word(w)}
            existing = {w.text: w for w in deck.words}
            for text in file_words - existing.keys():
                deck.words.append(Word(text=text, active=True))
            for text, word in existing.items():
                if text not in file_words:
                    word.active = False
    db.flush()


def deck_out(db: Session, deck: Deck, with_words: bool = False) -> dict[str, Any]:
    out = {
        "id": deck.id,
        "slug": deck.slug,
        "game_id": deck.game_id,
        "name": deck.name,
        "emoji": deck.emoji,
        "description": deck.description,
        "builtin": deck.builtin,
        "enabled": deck.enabled,
        "word_count": sum(1 for w in deck.words if w.active),
        "total_words": len(deck.words),
    }
    if with_words:
        stats = word_stats(db, [w.id for w in deck.words])
        out["words"] = [
            {"id": w.id, "text": w.text, "active": w.active, **stats.get(w.id, _empty_stats())}
            for w in deck.words
        ]
    return out


def _empty_stats() -> dict[str, Any]:
    return {"shown": 0, "correct": 0, "passed": 0, "correct_rate": None}


def word_stats(db: Session, word_ids: list[int]) -> dict[int, dict[str, Any]]:
    if not word_ids:
        return {}
    rows = db.execute(
        select(WordPlay.word_id, WordPlay.result, func.count())
        .join(GameSession, GameSession.id == WordPlay.session_id)
        .where(WordPlay.word_id.in_(word_ids), GameSession.status == "finished")
        .group_by(WordPlay.word_id, WordPlay.result)
    )
    out: dict[int, dict[str, Any]] = {}
    for word_id, result, count in rows:
        s = out.setdefault(word_id, _empty_stats())
        s["shown"] += count
        if result == "correct":
            s["correct"] += count
        else:
            s["passed"] += count
    for s in out.values():
        s["correct_rate"] = round(100 * s["correct"] / s["shown"]) if s["shown"] else None
    return out


def words_for_session(db: Session, session: GameSession) -> list[dict[str, Any]]:
    """Shuffled words from the session's decks. Words already used tonight go last."""
    deck_ids = [int(d) for d in (session.settings.get("decks") or [])]
    q = (
        select(Word, Deck)
        .join(Deck, Deck.id == Word.deck_id)
        .where(Deck.game_id == deck_game(session.game_id), Deck.enabled, Word.active)
    )
    if deck_ids:
        q = q.where(Deck.id.in_(deck_ids))
    rows = db.execute(q).all()
    used_tonight = set(
        db.scalars(
            select(WordPlay.word_id)
            .join(GameSession, GameSession.id == WordPlay.session_id)
            .where(GameSession.night_id == session.night_id, GameSession.id != session.id)
        )
    )
    fresh, used = [], []
    for word, deck in rows:
        item = {"id": word.id, "text": word.text, "deck": deck.name, "emoji": deck.emoji}
        (used if word.id in used_tonight else fresh).append(item)
    random.shuffle(fresh)
    random.shuffle(used)
    return fresh + used
