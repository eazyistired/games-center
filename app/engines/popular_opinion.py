"""Popular Opinion (everyone's phones only).

Each round a question with 2-4 options. Every player secretly taps
  1) their own answer   (these decide the majority)
  2) their guess of what most people answered
+1 for a guess that matches the majority (on a tie for most votes, every tied option counts).
Reveal: how many picked what (+ who, if "show who picked what" is on) and any lone wolf.
"""

from __future__ import annotations

import json
from collections import Counter
from functools import lru_cache
from typing import Any

from ..config import get_settings
from . import ActionError, Engine, register


@lru_cache
def questions() -> list[dict[str, Any]]:
    path = get_settings().games_dir / "popular-opinion" / "questions.json"
    return json.loads(path.read_text(encoding="utf-8"))["questions"]


class PopularOpinionEngine(Engine):
    game_id = "popular-opinion"

    def setup(self, ctx):
        spicy = bool(ctx.settings.get("spicy"))
        pool = [i for i, q in enumerate(questions()) if spicy or not q.get("spicy")]
        ctx.rng.shuffle(pool)
        state = {
            "ids": [p["id"] for p in ctx.players],
            "order": pool,
            "pos": 0,
            "rounds": int(ctx.settings.get("rounds") or 8),
            "show_names": bool(ctx.settings.get("show_names", True)),
            "round_no": 0,
            "scores": {str(p["id"]): 0 for p in ctx.players},
            "history": [],
            "finished": False,
        }
        self._new_round(state)
        return state

    def _new_round(self, state):
        if state["pos"] >= len(state["order"]):
            state["pos"] = 0
        q = state["order"][state["pos"]]
        state["pos"] += 1
        state["r"] = {
            "q": q,
            "phase": "answer",
            "answers": {},
            "guesses": {},
            "majority": [],
            "deltas": {},
            "wolves": [],
        }

    def act(self, state, ctx, actor, action):
        if state["finished"]:
            raise ActionError("The game is over")
        r = state["r"]
        q = questions()[r["q"]]
        kind = action.get("type")
        me = actor.player_id
        if kind in ("answer", "guess"):
            if r["phase"] != "answer":
                raise ActionError("Answers are closed")
            if me is None:
                raise ActionError("Join the game first")
            opt = action.get("option")
            if not isinstance(opt, int) or not 0 <= opt < len(q["options"]):
                raise ActionError("Pick one of the options")
            (r["answers"] if kind == "answer" else r["guesses"])[str(me)] = opt
            if all(str(i) in r["answers"] and str(i) in r["guesses"] for i in state["ids"]):
                self._reveal(state)
        elif kind == "reveal":
            if not actor.is_host:
                raise ActionError("Only the host can reveal early")
            if r["phase"] != "answer" or not r["answers"]:
                raise ActionError("Wait for at least one answer")
            self._reveal(state)
        elif kind == "skip":
            if not actor.is_host or r["phase"] != "answer":
                raise ActionError("Only the host can skip a question")
            self._new_round(state)
        elif kind == "next":
            if not actor.is_host or r["phase"] != "reveal":
                raise ActionError("The host goes to the next question")
            if state["round_no"] >= state["rounds"]:
                state["finished"] = True
            else:
                self._new_round(state)
        elif kind == "finish":
            if not actor.is_host:
                raise ActionError("Only the host can finish the game")
            state["finished"] = True
        else:
            raise ActionError(f"Unknown action {kind!r}")
        return state

    def _reveal(self, state):
        r = state["r"]
        counts = Counter(r["answers"].values())
        best = max(counts.values())
        r["majority"] = sorted(o for o, n in counts.items() if n == best)
        deltas = {pid: 1 for pid, g in r["guesses"].items() if g in r["majority"]}
        for pid, n in deltas.items():
            state["scores"][pid] += n
        if len(r["answers"]) >= 3:
            r["wolves"] = [int(pid) for pid, a in r["answers"].items() if counts[a] == 1]
        r["deltas"] = deltas
        r["phase"] = "reveal"
        state["round_no"] += 1
        state["history"].append(
            {
                "q": questions()[r["q"]]["q"],
                "counts": {str(k): v for k, v in counts.items()},
                "majority": r["majority"],
                "points": deltas,
            }
        )

    # ------------------------------------------------------------ views
    def _board(self, state, ctx):
        return [
            {
                "player_id": p["id"],
                "name": p["name"],
                "emoji": p["emoji"],
                "score": state["scores"][str(p["id"])],
            }
            for p in ctx.players
        ]

    def view(self, state, ctx, viewer):
        r = state["r"]
        q = questions()[r["q"]]
        me = viewer.player_id
        done = [int(i) for i in r["answers"] if i in r["guesses"]]
        out: dict[str, Any] = {
            "phase": r["phase"],
            "round": state["round_no"] + (0 if r["phase"] == "reveal" else 1),
            "rounds": state["rounds"],
            "last_round": state["round_no"] >= state["rounds"],
            "question": q["q"],
            "options": q["options"],
            "spicy": bool(q.get("spicy")),
            "me": me,
            "is_host": viewer.is_host,
            "my_answer": r["answers"].get(str(me)) if me is not None else None,
            "my_guess": r["guesses"].get(str(me)) if me is not None else None,
            "done": done,
            "players": [
                {"id": p["id"], "name": p["name"], "emoji": p["emoji"]} for p in ctx.players
            ],
            "scoreboard": self._board(state, ctx),
            "headline": f"Q{state['round_no'] + (0 if r['phase'] == 'reveal' else 1)}: {q['q']}",
            "finished": state["finished"],
        }
        if r["phase"] == "reveal":
            counts = Counter(r["answers"].values())
            out["reveal"] = {
                "counts": [counts.get(i, 0) for i in range(len(q["options"]))],
                "majority": r["majority"],
                "who": {
                    str(i): [int(p) for p, a in r["answers"].items() if a == i]
                    for i in range(len(q["options"]))
                }
                if state["show_names"]
                else None,
                "right": [int(p) for p in r["deltas"]],
                "wolves": r["wolves"] if state["show_names"] else [],
                "deltas": r["deltas"],
            }
            out["headline"] = (
                f"{q['q']} → most said {' / '.join(q['options'][i] for i in r['majority'])}"
            )
        return out

    def result(self, state, ctx):
        if not state["finished"]:
            return None
        n = len(state["history"])
        return {
            "scores": [{"player_id": i, "score": state["scores"][str(i)]} for i in state["ids"]],
            "details": {
                "summary": f"{n} question{'s' if n != 1 else ''}",
                "rounds": state["history"],
            },
        }

    def partial(self, state, ctx):
        if not state["history"]:
            return None
        return {
            "scores": [{"player_id": i, "score": state["scores"][str(i)]} for i in state["ids"]],
            "details": {"summary": f"{len(state['history'])} questions played"},
        }


register(PopularOpinionEngine())
