"""Game registry: every folder in games/ with a manifest.json is a game."""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import Game

log = logging.getLogger(__name__)

GAMES: dict[str, dict[str, Any]] = {}
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,59}$")

MANIFEST_DEFAULTS: dict[str, Any] = {
    "emoji": "🎲",
    "description": "",
    "min_players": 2,
    "max_players": 30,
    "modes": ["solo"],
    "teams": {"min": 2, "max": 4},
    "scoring": {"higher_is_better": True, "unit": "points"},
    "has_decks": False,
    "deck_source": None,  # use another game's decks, e.g. "heads-up"
    "settings": [],
    "entry": "index.html",
}


def load_manifests(games_dir: Path) -> dict[str, dict[str, Any]]:
    GAMES.clear()
    if not games_dir.is_dir():
        log.warning("games dir %s does not exist", games_dir)
        return GAMES
    for manifest_path in sorted(games_dir.glob("*/manifest.json")):
        folder = manifest_path.parent.name
        try:
            data = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            log.error("skipping %s: %s", manifest_path, exc)
            continue
        game_id = data.get("id", folder)
        if game_id != folder or not _ID_RE.match(game_id):
            log.error("skipping %s: id must match folder name and be a slug", manifest_path)
            continue
        manifest = {**MANIFEST_DEFAULTS, **data, "id": game_id}
        manifest["scoring"] = {**MANIFEST_DEFAULTS["scoring"], **data.get("scoring", {})}
        manifest.setdefault("name", game_id)
        GAMES[game_id] = manifest
    log.info("loaded %d game(s): %s", len(GAMES), ", ".join(GAMES))
    return GAMES


def get_manifest(game_id: str) -> dict[str, Any] | None:
    return GAMES.get(game_id)


def deck_game(game_id: str) -> str:
    """The game whose decks this game uses (itself unless the manifest sets deck_source)."""
    m = GAMES.get(game_id) or {}
    return m.get("deck_source") or game_id


def default_settings(manifest: dict[str, Any]) -> dict[str, Any]:
    return {s["key"]: s.get("default") for s in manifest.get("settings", [])}


def merged_settings(
    manifest: dict[str, Any], admin: dict[str, Any] | None, request: dict[str, Any] | None = None
) -> dict[str, Any]:
    """manifest defaults <- admin defaults <- per-session choices (known keys only)."""
    out = default_settings(manifest)
    for layer in (admin or {}, request or {}):
        for key, value in layer.items():
            if key in out:
                out[key] = value
    return out


def sync_games(db: Session) -> None:
    """Make sure every manifest has a row in the games table."""
    existing = {g.id for g in db.scalars(select(Game))}
    next_order = (db.scalar(select(func.max(Game.sort_order))) or 0) + 1
    for game_id in GAMES:
        if game_id not in existing:
            db.add(Game(id=game_id, enabled=True, sort_order=next_order, settings={}))
            next_order += 1
    db.flush()
