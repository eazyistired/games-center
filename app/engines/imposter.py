"""Imposter on everyone's phones.

Phases per round:
  reveal  -> everyone looks at their own card and taps "Got it"
  clues   -> one word each, in order (spoken out loud; the phone of the current player says so)
  discuss -> optional timer; host starts the vote (or asks for another lap)
  vote    -> secret vote on each phone (one runoff if there's a tie at the cut-off)
  guess   -> caught imposters type the word; exact match counts, otherwise the host judges
  result  -> reveal + points; host goes to the next round / finishes

Points (same as the one-phone game): imposter not caught +2 · caught imposter who guesses
the word +1 · every crew member +1 per caught imposter who misses.
"""

from __future__ import annotations

import time
import unicodedata
from collections import Counter
from typing import Any

from . import ActionError, Engine, register

PTS_ESCAPED, PTS_GUESSED, PTS_CREW = 2, 1, 1


def norm(text: str) -> str:
    text = unicodedata.normalize("NFKD", str(text)).encode("ascii", "ignore").decode()
    return "".join(ch for ch in text.lower() if ch.isalnum())


class ImposterEngine(Engine):
    game_id = "imposter"

    # ------------------------------------------------------------ setup
    def setup(self, ctx):
        ids = [p["id"] for p in ctx.players]
        n_imp = max(1, min(int(ctx.settings.get("imposters") or 1), (len(ids) - 1) // 2))
        rounds = int(ctx.settings.get("rounds") or 5)
        words = ctx.draw_words(rounds + 10)  # spares for "new word"
        if not words:
            raise ActionError("No words in the selected decks")
        state = {
            "ids": ids,
            "rounds": rounds,
            "n_imp": n_imp,
            "hint": bool(ctx.settings.get("hint", True)),
            "discussion": int(ctx.settings.get("discussion") or 0),
            "words": words,
            "word_pos": 0,
            "round_no": 0,
            "scores": {str(i): 0 for i in ids},
            "history": [],
            "last_imposters": [],
            "plays": [],
            "finished": False,
        }
        self._new_round(state, ctx)
        return state

    def _new_round(self, state, ctx):
        ids = state["ids"]
        if state["word_pos"] >= len(state["words"]):
            state["word_pos"] = 0
        word = state["words"][state["word_pos"]]
        state["word_pos"] += 1
        # never make the author of the word (friends' words) the imposter
        pool = [i for i in ids if i != word.get("author")]
        if len(pool) < state["n_imp"]:
            pool = ids
        fresh = [i for i in pool if i not in state["last_imposters"]]
        ctx.rng.shuffle(fresh)
        rest = [i for i in pool if i in state["last_imposters"]]
        ctx.rng.shuffle(rest)
        shift = state["round_no"] % len(ids)
        order = ids[shift:] + ids[:shift]
        state["r"] = {
            "phase": "reveal",
            "word": word,
            "imposters": (fresh + rest)[: state["n_imp"]],
            "seen": [],
            "order": order,
            "starter_idx": ctx.rng.randrange(len(order)),
            "clue_idx": 0,
            "laps": 1,
            "ends_at": None,
            "votes": {},
            "candidates": None,  # runoff: who can be voted for
            "slots": state["n_imp"],  # how many players the current vote decides
            "runoff": False,
            "accused": [],
            "guesses": {},  # imposter id -> {"text", "correct": True/False/None}
            "deltas": {},
        }

    # ------------------------------------------------------------ helpers
    @staticmethod
    def _clue_order(r):
        o = r["order"]
        s = r["starter_idx"]
        return o[s:] + o[:s]

    def _require(self, r, *phases):
        if r["phase"] not in phases:
            raise ActionError("Not now")

    # ------------------------------------------------------------ actions
    def act(self, state, ctx, actor, action):
        if state["finished"]:
            raise ActionError("The game is over")
        r = state["r"]
        kind = action.get("type")
        me = actor.player_id

        host_only = {"skip_word", "next_lap", "start_vote", "judge", "next_round", "finish"}
        if kind in host_only and not actor.is_host:
            raise ActionError("Only the host can do that")
        if kind not in host_only and me is None:
            raise ActionError("Join the game first")

        if kind == "seen":
            self._require(r, "reveal")
            if me not in r["seen"]:
                r["seen"].append(me)
            if len(r["seen"]) == len(state["ids"]):
                r["phase"] = "clues"
        elif kind == "clue_done":
            self._require(r, "clues")
            order = self._clue_order(r)
            current = order[r["clue_idx"] % len(order)]
            if me != current and not actor.is_host:
                raise ActionError("It's not your turn")
            r["clue_idx"] += 1
            if r["clue_idx"] >= len(order) * r["laps"]:
                self._to_discuss(state, r)
        elif kind == "next_lap":
            self._require(r, "clues", "discuss")
            r["laps"] += 1
            r["phase"] = "clues"
            r["ends_at"] = None
        elif kind == "start_vote":
            self._require(r, "clues", "discuss")
            r["phase"] = "vote"
            r["ends_at"] = None
        elif kind == "vote":
            self._require(r, "vote")
            targets = [int(t) for t in action.get("targets", [])]
            allowed = r["candidates"] if r["candidates"] is not None else state["ids"]
            if len(set(targets)) != r["slots"] or any(t not in allowed or t == me for t in targets):
                raise ActionError(
                    f"Pick {r['slots']} player{'s' if r['slots'] > 1 else ''} (not yourself)"
                )
            r["votes"][str(me)] = targets
            if all(str(i) in r["votes"] for i in state["ids"]):  # everyone votes, also in a runoff
                self._tally(state, r)
        elif kind == "guess":
            self._require(r, "guess")
            if str(me) not in r["guesses"] or r["guesses"][str(me)]["text"] is not None:
                raise ActionError("You don't need to guess")
            text = str(action.get("text", "")).strip()[:80]
            if not text:
                raise ActionError("Type the word")
            correct = True if norm(text) == norm(r["word"]["text"]) else None
            r["guesses"][str(me)] = {"text": text, "correct": correct}
            self._maybe_result(state, r)
        elif kind == "judge":
            self._require(r, "guess")
            pid = int(action.get("player_id"))
            g = r["guesses"].get(str(pid))
            if g is None or g["text"] is None:
                raise ActionError("Nothing to judge yet")
            g["correct"] = bool(action.get("correct"))
            self._maybe_result(state, r)
        elif kind == "skip_word":
            self._require(r, "reveal", "clues", "discuss")
            last = state["last_imposters"]  # new word + new imposter(s); the old word is skipped
            state["last_imposters"] = r["imposters"]
            self._new_round(state, ctx)
            state["last_imposters"] = last
        elif kind == "next_round":
            self._require(r, "result")
            if state["round_no"] >= state["rounds"]:
                raise ActionError("That was the last round")
            self._new_round(state, ctx)
        elif kind == "finish":
            state["finished"] = True
        else:
            raise ActionError(f"Unknown action {kind!r}")
        return state

    def _to_discuss(self, state, r):
        r["phase"] = "discuss"
        r["ends_at"] = time.time() + state["discussion"] if state["discussion"] else None

    def _tally(self, state, r):
        counts = Counter(t for ts in r["votes"].values() for t in ts)
        pool = r["candidates"] if r["candidates"] is not None else state["ids"]
        ranked = sorted(pool, key=lambda i: -counts.get(i, 0))
        slots = r["slots"]
        cutoff = counts.get(ranked[slots - 1], 0) if len(ranked) >= slots else 0
        sure = [i for i in ranked if counts.get(i, 0) > cutoff]
        tied = [i for i in ranked if counts.get(i, 0) == cutoff and cutoff > 0]
        r.setdefault("vote_log", []).append({"votes": dict(r["votes"]), "runoff": r["runoff"]})
        if len(sure) + len(tied) <= slots or cutoff == 0:
            r["accused"] += (sure + tied)[:slots] if cutoff > 0 else sure
            self._after_vote(state, r)
        elif not r["runoff"]:  # one runoff among the tied players for the remaining slots
            r["accused"] += sure
            r["runoff"] = True
            r["candidates"] = tied
            r["slots"] = slots - len(sure)
            r["votes"] = {}
        else:  # still tied: nobody else is caught
            r["accused"] += sure
            self._after_vote(state, r)

    def _after_vote(self, state, r):
        caught = [i for i in r["imposters"] if i in r["accused"]]
        # JSON object keys are strings: player ids are stored as str everywhere in the state
        r["guesses"] = {str(i): {"text": None, "correct": None} for i in caught}
        r["phase"] = "guess" if caught else "result"
        if not caught:
            self._score(state, r)

    def _maybe_result(self, state, r):
        if all(g["correct"] is not None for g in r["guesses"].values()):
            r["phase"] = "result"
            self._score(state, r)

    def _score(self, state, r):
        deltas: dict[str, int] = {}

        def add(pid, n):
            deltas[str(pid)] = deltas.get(str(pid), 0) + n

        crew = [i for i in state["ids"] if i not in r["imposters"]]
        for imp in r["imposters"]:
            g = r["guesses"].get(str(imp))
            if g is None:
                add(imp, PTS_ESCAPED)
            elif g["correct"]:
                add(imp, PTS_GUESSED)
            else:
                for c in crew:
                    add(c, PTS_CREW)
        for pid, n in deltas.items():
            state["scores"][pid] += n
        r["deltas"] = deltas
        state["round_no"] += 1
        all_caught = all(i in r["accused"] for i in r["imposters"])
        state["plays"].append(
            {"word_id": r["word"]["id"], "result": "correct" if all_caught else "pass"}
        )
        state["history"].append(
            {
                "word": r["word"]["text"],
                "imposters": r["imposters"],
                "accused": r["accused"],
                "guesses": {str(k): v for k, v in r["guesses"].items()},
                "points": deltas,
            }
        )
        state["last_imposters"] = r["imposters"]

    # ------------------------------------------------------------ views
    def _scoreboard(self, state, ctx):
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
        me = viewer.player_id
        phase = r["phase"]
        order = self._clue_order(r)
        current = order[r["clue_idx"] % len(order)] if phase == "clues" else None
        names = {p["id"]: p for p in ctx.players}
        headline = {
            "reveal": f"Round {state['round_no'] + 1}: looking at the cards",
            "clues": f"Clues: {names[current]['name']}'s turn" if current else "Clues",
            "discuss": "Discussing… who's the imposter?",
            "vote": "Tie! Re-vote" if r["runoff"] else "Secret vote",
            "guess": "The imposter guesses the word",
            "result": "Reveal!",
        }[phase]
        if phase == "result":
            imps = " & ".join(names[i]["name"] for i in r["imposters"])
            caught = all(i in r["accused"] for i in r["imposters"])
            headline = (
                f"{'Caught' if caught else 'Got away'}: {imps} · the word was “{r['word']['text']}”"
            )
        out: dict[str, Any] = {
            "phase": phase,
            "round": state["round_no"] + (0 if phase == "result" else 1),
            "rounds": state["rounds"],
            "last_round": state["round_no"] >= state["rounds"],
            "n_imp": state["n_imp"],
            "players": [
                {"id": p["id"], "name": p["name"], "emoji": p["emoji"]} for p in ctx.players
            ],
            "scoreboard": self._scoreboard(state, ctx),
            "headline": headline,
            "is_host": viewer.is_host,
            "me": me,
            "seen": r["seen"],
            "clue_order": order,
            "clue_idx": r["clue_idx"] % len(order),
            "clues_given": r["clue_idx"],
            "lap": r["laps"],
            "current": current,
            "ends_in": max(0, round(r["ends_at"] - time.time())) if r["ends_at"] else None,
            "voted": [int(k) for k in r["votes"]],
            "candidates": r["candidates"],
            "slots": r["slots"],
            "runoff": r["runoff"],
            "guessing": [
                {"player_id": int(k), "text": v["text"], "correct": v["correct"]}
                for k, v in r["guesses"].items()
            ]
            if phase in ("guess", "result")
            else [],
            "finished": state["finished"],
        }
        if me is not None:
            if me in r["imposters"]:
                out["card"] = {
                    "role": "imposter",
                    "category": f"{r['word']['emoji']} {r['word']['deck']}"
                    if state["hint"]
                    else None,
                    "n_imp": state["n_imp"],
                }
            else:
                out["card"] = {
                    "role": "crew",
                    "word": r["word"]["text"],
                    "category": f"{r['word']['emoji']} {r['word']['deck']}",
                }
            out["my_vote"] = r["votes"].get(str(me))
        if phase == "result":
            out["reveal"] = {
                "imposters": r["imposters"],
                "accused": r["accused"],
                "word": r["word"]["text"],
                "category": f"{r['word']['emoji']} {r['word']['deck']}",
                "votes": (r.get("vote_log") or [{}])[0].get("votes", {}),
                "runoff_votes": r["vote_log"][1]["votes"]
                if len(r.get("vote_log") or []) > 1
                else None,
                "deltas": r["deltas"],
            }
        return out

    # ------------------------------------------------------------ result
    def _scores(self, state, ctx):
        return [{"player_id": p["id"], "score": state["scores"][str(p["id"])]} for p in ctx.players]

    def result(self, state, ctx):
        if not state["finished"]:
            return None
        escapes = sum(
            1 for h in state["history"] if any(i not in h["accused"] for i in h["imposters"])
        )
        n = len(state["history"])
        return {
            "scores": self._scores(state, ctx),
            "details": {
                "summary": f"{n} round{'s' if n != 1 else ''} · imposters escaped {escapes} time{'s' if escapes != 1 else ''}",
                "rounds": state["history"],
            },
            "word_plays": state["plays"],
        }

    def partial(self, state, ctx):
        if not state["history"]:
            return None
        return {
            "scores": self._scores(state, ctx),
            "details": {"summary": f"{len(state['history'])} rounds played"},
        }


register(ImposterEngine())
