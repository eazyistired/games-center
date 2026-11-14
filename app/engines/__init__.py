"""Server-side game engines for multi-phone play.

A multi-phone game keeps its rules here, in Python, so secrets (the imposter, the target...) never
reach a phone that shouldn't see them - not even the host's. Each phone only receives
`view(state, viewer)`.

    class MyGame(Engine):
        game_id = "my-game"
        def setup(self, ctx): return {...}                       # initial state (JSON-able)
        def act(self, state, ctx, actor, action): ...; return state  # raise ActionError to refuse
        def view(self, state, ctx, viewer): return {...}          # what this phone may see
        def result(self, state, ctx): return None or {"scores": [...], "details": {...}}

    register(MyGame())

Conventions for `view(..., viewer)` with `viewer.player_id is None` (spectators / TV):
return public info only, ideally with `headline` (str) and `scoreboard`
([{name, emoji, score, team?}]) so the generic watch screen can show it.
"""

from __future__ import annotations

import importlib
import logging
import os
import random
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger(__name__)


class ActionError(ValueError):
    """The action isn't allowed right now (shown to the player)."""


@dataclass
class Ctx:
    session_id: int
    mode: str  # solo | teams
    settings: dict[str, Any]
    players: list[dict[str, Any]]  # [{id, name, emoji, team_idx}]
    teams: list[dict[str, Any]]  # [{idx, name, color, player_ids}]
    draw_words: Callable[[int], list[dict[str, Any]]] = lambda n: []
    rng: random.Random = field(default_factory=random.Random)

    def player(self, player_id: int) -> dict[str, Any] | None:
        return next((p for p in self.players if p["id"] == player_id), None)


@dataclass
class Actor:
    player_id: int | None  # the seat this phone holds (None = not seated)
    is_host: bool


@dataclass
class Viewer:
    player_id: int | None  # None = spectator / TV
    is_host: bool = False


class Engine:
    game_id: str = ""

    def setup(self, ctx: Ctx) -> dict[str, Any]:
        raise NotImplementedError

    def act(self, state: dict, ctx: Ctx, actor: Actor, action: dict) -> dict:
        raise NotImplementedError

    def view(self, state: dict, ctx: Ctx, viewer: Viewer) -> dict[str, Any]:
        raise NotImplementedError

    def result(self, state: dict, ctx: Ctx) -> dict[str, Any] | None:
        """{"scores": [...], "details": {...}} once the game is over, else None."""
        return None

    def partial(self, state: dict, ctx: Ctx) -> dict[str, Any] | None:
        """Scores so far (same format as result) - used if the session goes idle."""
        return None


ENGINES: dict[str, Engine] = {}


def register(engine: Engine) -> Engine:
    ENGINES[engine.game_id] = engine
    return engine


def get_engine(game_id: str) -> Engine | None:
    return ENGINES.get(game_id)


def load_engines() -> None:
    """Import the built-in engines plus any modules listed in EXTRA_ENGINES (dev/tests)."""
    builtin: list[str] = []  # e.g. "app.engines.imposter" (added per game)
    extra = [m.strip() for m in os.environ.get("EXTRA_ENGINES", "").split(",") if m.strip()]
    for module in builtin + extra:
        try:
            importlib.import_module(module)
        except Exception:  # pragma: no cover - a broken engine must not kill the app
            log.exception("could not load engine module %s", module)
    if ENGINES:
        log.info("multi-phone engines: %s", ", ".join(ENGINES))
