"""Test-only multi-phone engine: everyone has a secret word; tap to score; first to `target` wins."""

from app.engines import ActionError, Engine, register


class DemoTapRace(Engine):
    game_id = "demo-multi"

    def setup(self, ctx):
        words = ["apple", "banana", "cherry", "plum", "kiwi", "mango", "pear", "fig"]
        return {
            "taps": {str(p["id"]): 0 for p in ctx.players},
            "secret": {str(p["id"]): words[i % len(words)] for i, p in enumerate(ctx.players)},
            "target": int(ctx.settings.get("target") or 3),
            "round": 1,
        }

    def act(self, state, ctx, actor, action):
        kind = action.get("type")
        if kind == "tap":
            if actor.player_id is None:
                raise ActionError("Spectators can't tap")
            state["taps"][str(actor.player_id)] += 1
        elif kind == "reset":
            if not actor.is_host:
                raise ActionError("Only the host can reset")
            state["taps"] = {k: 0 for k in state["taps"]}
            state["round"] += 1
        else:
            raise ActionError(f"Unknown action {kind!r}")
        return state

    def _board(self, state, ctx):
        return [
            {"name": p["name"], "emoji": p["emoji"], "score": state["taps"][str(p["id"])]}
            for p in ctx.players
        ]

    def view(self, state, ctx, viewer):
        out = {
            "headline": f"Round {state['round']}: first to {state['target']}",
            "scoreboard": self._board(state, ctx),
            "is_host": viewer.is_host,
        }
        if viewer.player_id is not None:
            out["my_secret"] = state["secret"][str(viewer.player_id)]
        return out

    def result(self, state, ctx):
        if max(state["taps"].values()) >= state["target"]:
            return {
                "scores": [
                    {"player_id": p["id"], "score": state["taps"][str(p["id"])]}
                    for p in ctx.players
                ],
                "details": {"summary": "Tap race finished"},
            }
        return None

    def partial(self, state, ctx):
        return {
            "scores": [
                {"player_id": p["id"], "score": state["taps"][str(p["id"])]} for p in ctx.players
            ]
        }


register(DemoTapRace())
