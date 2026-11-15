"""Three Rounds on everyone's phones.

Teams alternate; the clue-giver rotates within the team and plays on their OWN phone (only that
phone ever receives the word). One pool of words for three rounds: describe / one word / mime.

Turn phases:
  ready  -> the clue-giver taps Start (3 s countdown on every phone)
  play   -> Got it / Skip on the clue-giver's phone; the server keeps the clock
  paused -> clue-giver or host paused; resume restarts with a countdown
  review -> the clue-giver fixes mistakes, then confirms
Skipped words leave the game; the word on screen at time-up goes back in the hat; when the hat
empties mid-turn the leftover time carries into the next round.
"""

from __future__ import annotations

import time
from typing import Any

from . import ActionError, Engine, register

ROUNDS = [
    {"name": "Describe", "emoji": "🗣️", "rule": "Say anything except the word itself."},
    {"name": "One word", "emoji": "☝️", "rule": "Exactly ONE word as a clue."},
    {"name": "Mime", "emoji": "🤐", "rule": "No words, no sounds: act it out."},
]
COUNTDOWN = 3.0  # seconds before the clock starts
GRACE = 1.5  # seconds of network slack at the buzzer
CARRY_MIN = 5.0  # leftover seconds worth carrying into the next round


def now() -> float:
    return time.time()


class ThreeRoundsEngine(Engine):
    game_id = "three-rounds"

    # ------------------------------------------------------------ setup
    def setup(self, ctx):
        if len(ctx.teams) < 2:
            raise ActionError("Three Rounds needs at least two teams")
        s = ctx.settings
        want = (
            10_000
            if s.get("collect_words")
            else max(8, int(s.get("words_per_player") or 4) * len(ctx.players))
        )
        words = ctx.draw_words(want)
        if not words:
            raise ActionError("No words in the selected decks")
        ids = [w["id"] for w in words]
        ctx.rng.shuffle(ids)
        state = {
            "words": {
                str(w["id"]): {"text": w["text"], "deck": w.get("deck"), "emoji": w.get("emoji")}
                for w in words
            },
            "turn_seconds": int(s.get("turn_seconds") or 45),
            "skips": 1 if s.get("skips") is None else int(s.get("skips")),
            "round": 0,
            "remaining": ids,
            "discarded": [],
            "turn_no": 0,
            "team_turns": {},
            "scores": {str(t["idx"]): 0 for t in ctx.teams},
            "per_round": [{}, {}, {}],
            "per_player": {},
            "carry": None,
            "plays": [],
            "log": [],
            "new_round": True,
            "finished": False,
        }
        self._new_turn(state, ctx)
        return state

    def _new_turn(self, state, ctx):
        carry = state["carry"]
        if carry:
            team, giver, secs = carry["team"], carry["giver"], carry["seconds"]
        else:
            t = ctx.teams[state["turn_no"] % len(ctx.teams)]
            n = state["team_turns"].get(str(t["idx"]), 0)
            team, giver, secs = (
                t["idx"],
                t["player_ids"][n % len(t["player_ids"])],
                float(state["turn_seconds"]),
            )
        state["t"] = {
            "phase": "ready",
            "team": team,
            "giver": giver,
            "carried": bool(carry),
            "seconds": secs,
            "starts_at": None,
            "ends_at": None,
            "left": None,  # seconds left while paused
            "pool": [],
            "items": [],  # [{id, kind: correct|skip|timeout, correct: bool}]
            "skips_used": 0,
            "reason": None,
            "left_at_end": 0.0,
        }

    # ------------------------------------------------------------ actions
    def act(self, state, ctx, actor, action):
        if state["finished"]:
            raise ActionError("The game is over")
        t = state["t"]
        kind = action.get("type")
        giver = actor.player_id is not None and actor.player_id == t["giver"]
        boss = giver or actor.is_host

        if kind == "start":
            self._phase(t, "ready")
            if not boss:
                raise ActionError("The clue-giver starts the turn")
            t["pool"] = list(state["remaining"])
            t["starts_at"] = now() + COUNTDOWN
            t["ends_at"] = t["starts_at"] + t["seconds"]
            t["phase"] = "play"
            state["new_round"] = False
        elif kind in ("got", "skip"):
            self._phase(t, "play")
            if not giver:
                raise ActionError("Only the clue-giver can do that")
            if now() > t["ends_at"] + GRACE:
                self._end(state, "time")
                return state
            if now() < t["starts_at"] - 0.3:
                raise ActionError("Wait for the countdown")
            if kind == "skip" and state["skips"] < 99 and t["skips_used"] >= state["skips"]:
                raise ActionError("No skips left this turn")
            word = t["pool"].pop(0)
            t["items"].append(
                {
                    "id": word,
                    "kind": "correct" if kind == "got" else "skip",
                    "correct": kind == "got",
                }
            )
            if kind == "skip":
                t["skips_used"] += 1
            if not t["pool"]:
                t["left_at_end"] = max(0.0, t["ends_at"] - now())
                self._end(state, "pool")
        elif kind == "time_up":
            self._phase(t, "play")
            if not boss:
                raise ActionError("Not yours to call")
            if now() < t["ends_at"] - 1.0:
                raise ActionError("There's still time left")
            self._end(state, "time")
        elif kind == "pause":
            self._phase(t, "play")
            if not boss:
                raise ActionError("The clue-giver or host can pause")
            t["left"] = max(0.0, t["ends_at"] - max(now(), t["starts_at"]))
            t["phase"] = "paused"
        elif kind == "resume":
            self._phase(t, "paused")
            if not boss:
                raise ActionError("The clue-giver or host can resume")
            t["starts_at"] = now() + COUNTDOWN
            t["ends_at"] = t["starts_at"] + t["left"]
            t["left"] = None
            t["phase"] = "play"
        elif kind == "end_turn":
            if t["phase"] not in ("play", "paused"):
                raise ActionError("Not now")
            if not boss:
                raise ActionError("The clue-giver or host can end the turn")
            self._end(state, "ended")
        elif kind == "toggle":
            self._phase(t, "review")
            if not boss:
                raise ActionError("The clue-giver checks the words")
            i = int(action.get("index", -1))
            if not 0 <= i < len(t["items"]):
                raise ActionError("No such word")
            t["items"][i]["correct"] = not t["items"][i]["correct"]
        elif kind == "confirm":
            self._phase(t, "review")
            if not boss:
                raise ActionError("The clue-giver confirms")
            self._apply(state, ctx)
        elif kind == "finish":
            if not actor.is_host:
                raise ActionError("Only the host can finish the game")
            state["finished"] = True
        else:
            raise ActionError(f"Unknown action {kind!r}")
        return state

    @staticmethod
    def _phase(t, *phases):
        if t["phase"] not in phases:
            raise ActionError("Not now")

    def _end(self, state, reason):
        t = state["t"]
        if reason != "pool" and t["pool"]:
            t["items"].append({"id": t["pool"][0], "kind": "timeout", "correct": False})
        t["reason"] = reason
        t["phase"] = "review"

    def _apply(self, state, ctx):
        t = state["t"]
        correct = [i["id"] for i in t["items"] if i["correct"]]
        skipped = [i["id"] for i in t["items"] if not i["correct"] and i["kind"] == "skip"]
        gone = set(correct) | set(skipped)
        state["remaining"] = [w for w in state["remaining"] if w not in gone]
        state["discarded"] += skipped
        team = str(t["team"])
        r = state["round"]
        state["scores"][team] += len(correct)
        state["per_round"][r][team] = state["per_round"][r].get(team, 0) + len(correct)
        pid = str(t["giver"])
        state["per_player"][pid] = state["per_player"].get(pid, 0) + len(correct)
        state["plays"] += [{"word_id": w, "result": "correct"} for w in correct]
        state["plays"] += [{"word_id": w, "result": "pass"} for w in skipped]
        state["log"].append(
            {
                "round": r,
                "team": t["team"],
                "player_id": t["giver"],
                "correct": len(correct),
                "skipped": len(skipped),
            }
        )

        round_done = not state["remaining"]
        carry = None
        if round_done and t["reason"] == "pool" and t["left_at_end"] >= CARRY_MIN and r < 2:
            carry = {"team": t["team"], "giver": t["giver"], "seconds": round(t["left_at_end"], 1)}
        if not carry:  # this team's turn is over
            state["turn_no"] += 1
            state["team_turns"][team] = state["team_turns"].get(team, 0) + 1
        state["carry"] = carry
        if round_done:
            state["round"] += 1
            out = set(state["discarded"])
            ids = [int(k) for k in state["words"] if int(k) not in out]
            ctx.rng.shuffle(ids)
            state["remaining"] = ids
            state["new_round"] = True
            if state["round"] >= 3 or not ids:
                state["finished"] = True
                return
        self._new_turn(state, ctx)

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
                "rounds": [state["per_round"][r].get(str(t["idx"]), 0) for r in range(3)],
            }
            for t in ctx.teams
        ]

    def view(self, state, ctx, viewer):
        t = state["t"]
        me = viewer.player_id
        is_giver = me is not None and me == t["giver"]
        team = next(x for x in ctx.teams if x["idx"] == t["team"])
        giver = ctx.player(t["giver"]) or {"name": "?", "emoji": "🙂"}
        rnd = ROUNDS[min(state["round"], 2)]
        clock = now()
        got = sum(1 for i in t["items"] if i["correct"])
        my_team = next((x["idx"] for x in ctx.teams if me in x["player_ids"]), None)
        out: dict[str, Any] = {
            "phase": t["phase"],
            "round": state["round"],
            "round_info": rnd,
            "rounds": ROUNDS,
            "new_round": state["new_round"],
            "team": t["team"],
            "team_name": team["name"],
            "team_color": team["color"],
            "giver": t["giver"],
            "carried": t["carried"],
            "turn_seconds": t["seconds"],
            "me": me,
            "my_team": my_team,
            "is_giver": is_giver,
            "is_host": viewer.is_host,
            "starts_in": max(0.0, t["starts_at"] - clock) if t["phase"] == "play" else None,
            "ends_in": max(0.0, t["ends_at"] - clock) if t["phase"] == "play" else None,
            "left": t["left"],
            "got": got,
            "skips_left": None
            if state["skips"] >= 99
            else max(0, state["skips"] - t["skips_used"]),
            "hat": len(t["pool"]) if t["phase"] in ("play", "paused") else len(state["remaining"]),
            "words_total": len(state["words"]) - len(state["discarded"]),
            "reason": t["reason"],
            "players": [
                {"id": p["id"], "name": p["name"], "emoji": p["emoji"]} for p in ctx.players
            ],
            "scoreboard": self._scoreboard(state, ctx),
            "finished": state["finished"],
        }
        if is_giver or (viewer.is_host and t["phase"] == "review"):
            if t["phase"] == "play" and t["pool"]:
                w = state["words"][str(t["pool"][0])]
                out["word"] = {"id": t["pool"][0], **w}
            if t["phase"] == "review":
                out["items"] = [
                    {
                        "text": state["words"][str(i["id"])]["text"],
                        "kind": i["kind"],
                        "correct": i["correct"],
                    }
                    for i in t["items"]
                ]
        phase_text = {
            "ready": f"{rnd['emoji']} Round {state['round'] + 1}: {giver['name']}'s turn (Team {team['name']})",
            "play": f"{rnd['emoji']} Team {team['name']}: {got} so far · {out['hat']} left in the hat",
            "paused": "⏸ Paused",
            "review": f"Team {team['name']} got {got}",
        }[t["phase"]]
        out["headline"] = phase_text
        return out

    # ------------------------------------------------------------ result
    def _scores(self, state, ctx):
        return [{"team": t["idx"], "score": state["scores"][str(t["idx"])]} for t in ctx.teams]

    def result(self, state, ctx):
        if not state["finished"]:
            return None
        total = sum(state["scores"].values())
        best = max(state["per_player"].items(), key=lambda kv: kv[1], default=None)
        name = (ctx.player(int(best[0])) or {}).get("name") if best and best[1] else None
        n = max(1, min(state["round"], 3))
        summary = f"{total} words guessed over {n} round{'s' if n != 1 else ''}" + (
            f" · best clue-giver {name} ({best[1]})" if name else ""
        )
        return {
            "scores": self._scores(state, ctx),
            "details": {
                "summary": summary,
                "per_round": state["per_round"],
                "per_player": state["per_player"],
                "turns": state["log"],
            },
            "word_plays": state["plays"],
        }

    def partial(self, state, ctx):
        if not state["log"]:
            return None
        return {
            "scores": self._scores(state, ctx),
            "details": {"summary": f"{len(state['log'])} turns played"},
        }


register(ThreeRoundsEngine())
