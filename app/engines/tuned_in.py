"""Tuned In on everyone's phones.

Per turn (teams alternate; the clue-giver rotates within the team):
  clue   -> only the clue-giver sees the target (may swap the card); taps "got a clue"
  guess  -> the team drags the needle on their own phones (live everywhere); anyone locks it in
  bet    -> each other team bets left/right of the needle (+1, void on a bullseye)
  reveal -> target + points; host / clue-giver goes to the next turn
Bullseye 4 · close 3 · near 2. Play to N, checked after equal turns, the leader must be alone.
"""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

from ..config import get_settings
from . import ActionError, Engine, register

ZONE = 0.035
ZONES = [(4, ZONE), (3, ZONE * 3), (2, ZONE * 5)]


def points_for(d: float) -> int:
    return next((p for p, w in ZONES if d <= w), 0)


@lru_cache
def pairs() -> list[list[str]]:
    path = get_settings().games_dir / "tuned-in" / "spectrums.json"
    return json.loads(path.read_text(encoding="utf-8"))["pairs"]


class TunedInEngine(Engine):
    game_id = "tuned-in"

    # ------------------------------------------------------------ setup
    def setup(self, ctx):
        if len(ctx.teams) < 2:
            raise ActionError("Tuned In needs at least two teams")
        order = list(range(len(pairs())))
        ctx.rng.shuffle(order)
        state = {
            "play_to": int(ctx.settings.get("play_to") or 10),
            "bet": bool(ctx.settings.get("bet", True)),
            "swaps": int(ctx.settings.get("swaps") if ctx.settings.get("swaps") is not None else 1),
            "deck": order,
            "deck_pos": 0,
            "turn_no": 0,
            "team_turns": {},
            "scores": {str(t["idx"]): 0 for t in ctx.teams},
            "log": [],
            "finished": False,
        }
        self._new_turn(state, ctx)
        return state

    def _draw(self, state):
        if state["deck_pos"] >= len(state["deck"]):
            state["deck_pos"] = 0
        card = state["deck"][state["deck_pos"]]
        state["deck_pos"] += 1
        return card

    def _new_turn(self, state, ctx):
        team = ctx.teams[state["turn_no"] % len(ctx.teams)]
        n = state["team_turns"].get(str(team["idx"]), 0)
        state["t"] = {
            "phase": "clue",
            "team": team["idx"],
            "giver": team["player_ids"][n % len(team["player_ids"])],
            "card": self._draw(state),
            "target": round(0.03 + ctx.rng.random() * 0.94, 4),
            "swaps_used": 0,
            "needle": 0.5,
            "moved_by": None,
            "bets": {},
            "points": None,
            "deltas": {},
        }

    @staticmethod
    def _team_of(ctx, player_id):
        return next((t["idx"] for t in ctx.teams if player_id in t["player_ids"]), None)

    # ------------------------------------------------------------ actions
    def act(self, state, ctx, actor, action):
        if state["finished"]:
            raise ActionError("The game is over")
        t = state["t"]
        kind = action.get("type")
        me = actor.player_id
        my_team = self._team_of(ctx, me)
        giver = me == t["giver"]

        if kind == "swap":
            self._phase(t, "clue")
            if not giver:
                raise ActionError("Only the clue-giver can swap the card")
            if t["swaps_used"] >= state["swaps"]:
                raise ActionError("No swaps left")
            t["swaps_used"] += 1
            t["card"] = self._draw(state)
            t["target"] = round(0.03 + ctx.rng.random() * 0.94, 4)
        elif kind == "clue_ready":
            self._phase(t, "clue")
            if not giver and not actor.is_host:
                raise ActionError("Only the clue-giver can do that")
            t["phase"] = "guess"
        elif kind == "needle":
            self._phase(t, "guess")
            if my_team != t["team"] or giver:
                raise ActionError("Only the clue-giver's teammates move the needle")
            try:
                value = float(action.get("value"))
            except (TypeError, ValueError) as exc:
                raise ActionError("Bad needle value") from exc
            t["needle"] = round(min(1.0, max(0.0, value)), 4)
            t["moved_by"] = me
        elif kind == "lock":
            self._phase(t, "guess")
            if (my_team != t["team"] or giver) and not actor.is_host:
                raise ActionError("Only the guessing team can lock it in")
            others = [x for x in ctx.teams if x["idx"] != t["team"]]
            if state["bet"] and others:
                t["phase"] = "bet"
            else:
                self._reveal(state, ctx)
        elif kind == "bet":
            self._phase(t, "bet")
            if my_team is None or my_team == t["team"]:
                raise ActionError("Only the other teams bet")
            side = action.get("side")
            if side not in ("left", "right"):
                raise ActionError("Bet left or right")
            t["bets"][str(my_team)] = side
            if all(str(x["idx"]) in t["bets"] for x in ctx.teams if x["idx"] != t["team"]):
                self._reveal(state, ctx)
        elif kind == "reveal":  # host: don't wait for missing bets
            self._phase(t, "bet")
            if not actor.is_host:
                raise ActionError("Only the host can reveal early")
            self._reveal(state, ctx)
        elif kind == "next":
            self._phase(t, "reveal")
            if not (giver or actor.is_host):
                raise ActionError("The clue-giver or the host continues")
            if self._is_over(state, ctx):
                state["finished"] = True
            else:
                self._new_turn(state, ctx)
        elif kind == "finish":
            if not actor.is_host:
                raise ActionError("Only the host can finish the game")
            state["finished"] = True
        else:
            raise ActionError(f"Unknown action {kind!r}")
        return state

    @staticmethod
    def _phase(t, phase):
        if t["phase"] != phase:
            raise ActionError("Not now")

    def _reveal(self, state, ctx):
        t = state["t"]
        pts = points_for(abs(t["needle"] - t["target"]))
        side = "left" if t["target"] < t["needle"] else "right"
        deltas: dict[str, int] = {}
        if pts:
            deltas[str(t["team"])] = pts
        for team, guess in t["bets"].items():
            if pts != 4 and guess == side:  # nobody wins a bet against a bullseye
                deltas[team] = deltas.get(team, 0) + 1
        for team, n in deltas.items():
            state["scores"][team] += n
        t["points"], t["deltas"], t["side"] = pts, deltas, side
        t["phase"] = "reveal"
        state["turn_no"] += 1
        state["team_turns"][str(t["team"])] = state["team_turns"].get(str(t["team"]), 0) + 1
        state["log"].append(
            {
                "team": t["team"],
                "player_id": t["giver"],
                "card": pairs()[t["card"]],
                "target": t["target"],
                "needle": t["needle"],
                "points": pts,
                "bets": t["bets"],
            }
        )

    def _is_over(self, state, ctx):
        if state["turn_no"] % len(ctx.teams) != 0:
            return False
        scores = list(state["scores"].values())
        best = max(scores)
        return best >= state["play_to"] and scores.count(best) == 1

    # ------------------------------------------------------------ views
    def _scoreboard(self, state, ctx):
        emo = {p["id"]: p["emoji"] for p in ctx.players}
        return [
            {
                "team": t["idx"],
                "name": t["name"],
                "color": t["color"],
                "emoji": "".join(emo.get(i, "") for i in t["player_ids"]),
                "score": state["scores"][str(t["idx"])],
            }
            for t in ctx.teams
        ]

    def view(self, state, ctx, viewer):
        t = state["t"]
        me = viewer.player_id
        team = next(x for x in ctx.teams if x["idx"] == t["team"])
        giver = ctx.player(t["giver"]) or {"name": "?", "emoji": "🙂"}
        phase = t["phase"]
        card = pairs()[t["card"]]
        sees_target = phase == "reveal" or (me == t["giver"] and phase in ("clue", "guess", "bet"))
        my_team = self._team_of(ctx, me)
        if phase == "reveal":
            pts = t["points"]
            reveal_text = (
                "🎯 Bullseye!"
                if pts == 4
                else f"+{pts} for Team {team['name']}"
                if pts
                else "Missed!"
            )
        else:
            reveal_text = ""
        headline = {
            "clue": f"Team {team['name']}: {giver['name']} is thinking of a clue",
            "guess": f"Team {team['name']} is turning the dial",
            "bet": "Other teams are betting",
            "reveal": reveal_text,
        }[phase]
        out: dict[str, Any] = {
            "phase": phase,
            "team": t["team"],
            "team_name": team["name"],
            "team_color": team["color"],
            "giver": t["giver"],
            "me": me,
            "my_team": my_team,
            "is_host": viewer.is_host,
            "is_giver": me is not None and me == t["giver"],
            "can_move": phase == "guess" and my_team == t["team"] and me != t["giver"],
            "can_bet": phase == "bet" and my_team is not None and my_team != t["team"],
            "card": card if (phase != "clue" or me == t["giver"]) else None,
            "swaps_left": state["swaps"] - t["swaps_used"],
            "needle": t["needle"],
            "moved_by": t["moved_by"],
            "target": t["target"] if sees_target else None,
            "bets": t["bets"],
            "points": t["points"],
            "deltas": t["deltas"],
            "play_to": state["play_to"],
            "turn": state["turn_no"] + (0 if phase == "reveal" else 1),
            "teams": [
                {
                    "idx": x["idx"],
                    "name": x["name"],
                    "color": x["color"],
                    "player_ids": x["player_ids"],
                }
                for x in ctx.teams
            ],
            "players": [
                {"id": p["id"], "name": p["name"], "emoji": p["emoji"]} for p in ctx.players
            ],
            "scoreboard": self._scoreboard(state, ctx),
            "headline": headline,
            "finished": state["finished"],
        }
        # the TV / watch screen draws the dial too (target only at the reveal)
        out["dial"] = {
            "left": card[0] if phase != "clue" else None,
            "right": card[1] if phase != "clue" else None,
            "needle": t["needle"],
            "target": t["target"] if phase == "reveal" else None,
        }
        return out

    # ------------------------------------------------------------ result
    def _scores(self, state, ctx):
        return [{"team": t["idx"], "score": state["scores"][str(t["idx"])]} for t in ctx.teams]

    def result(self, state, ctx):
        if not state["finished"]:
            return None
        bulls = sum(1 for x in state["log"] if x["points"] == 4)
        n = len(state["log"])
        return {
            "scores": self._scores(state, ctx),
            "details": {
                "summary": f"{n} turns · {bulls} bullseye{'s' if bulls != 1 else ''}",
                "turns": state["log"],
            },
        }

    def partial(self, state, ctx):
        if not state["log"]:
            return None
        return {
            "scores": self._scores(state, ctx),
            "details": {"summary": f"{len(state['log'])} turns played"},
        }


register(TunedInEngine())
