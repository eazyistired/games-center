"""Imposter engine rules, driven directly (no HTTP)."""

import json
import random

import pytest

from app.engines import ActionError, Actor, Ctx, Viewer
from app.engines.imposter import ImposterEngine, norm

E = ImposterEngine()
WORDS = [
    {"id": i, "text": t, "deck": "Animals", "emoji": "🦁"}
    for i, t in enumerate(["Giraffe", "Penguin", "Crème brûlée", "Owl"] * 4)
]


def make(n=5, **settings):
    players = [{"id": i, "name": f"P{i}", "emoji": "🙂", "team_idx": None} for i in range(1, n + 1)]
    ctx = Ctx(
        1,
        "solo",
        {"rounds": 3, "imposters": 1, "hint": True, "discussion": 0, **settings},
        players,
        [],
        draw_words=lambda k: WORDS[:k],
        rng=random.Random(4),
    )
    return ctx, json.loads(json.dumps(E.setup(ctx)))


def act(state, ctx, who, host=False, **action):
    # like the server: the state is stored as JSON between actions (int keys become strings!)
    state = json.loads(json.dumps(state))
    return json.loads(json.dumps(E.act(state, ctx, Actor(who, host), action)))


def to_vote(state, ctx):
    for p in state["ids"]:
        state = act(state, ctx, p, type="seen")
    while state["r"]["phase"] == "clues":
        state = act(state, ctx, state["r"]["order"][0], host=True, type="clue_done")
    return act(state, ctx, None, host=True, type="start_vote")


def test_cards_are_private():
    ctx, s = make()
    imp = s["r"]["imposters"][0]
    crew = next(i for i in s["ids"] if i != imp)
    assert E.view(s, ctx, Viewer(imp))["card"] == {
        "role": "imposter",
        "category": "🦁 Animals",
        "n_imp": 1,
    }
    assert E.view(s, ctx, Viewer(crew))["card"]["word"] == "Giraffe"
    spectator = E.view(s, ctx, Viewer(None))
    assert (
        "card" not in spectator
        and "Giraffe" not in str(spectator)
        and str(imp) not in str(spectator["seen"])
    )


def test_turn_order_and_host_rules():
    ctx, s = make()
    with pytest.raises(ActionError):
        act(s, ctx, 1, type="start_vote")  # not host
    for p in s["ids"]:
        s = act(s, ctx, p, type="seen")
    assert s["r"]["phase"] == "clues"
    v = E.view(s, ctx, Viewer(1))
    current = v["current"]
    other = next(i for i in s["ids"] if i != current)
    with pytest.raises(ActionError, match="not your turn"):
        act(s, ctx, other, type="clue_done")
    s = act(s, ctx, current, type="clue_done")
    assert E.view(s, ctx, Viewer(1))["current"] != current


def test_catch_imposter_who_misses_the_word():
    ctx, s = make()
    s = to_vote(s, ctx)
    imp = s["r"]["imposters"][0]
    for p in s["ids"]:
        target = imp if p != imp else next(i for i in s["ids"] if i != imp)
        s = act(s, ctx, p, type="vote", targets=[target])
    assert s["r"]["phase"] == "guess"
    with pytest.raises(ActionError):
        act(s, ctx, next(i for i in s["ids"] if i != imp), type="guess", text="x")
    s = act(s, ctx, imp, type="guess", text="zebra")
    assert s["r"]["phase"] == "guess"  # not an exact match -> host judges
    s = act(s, ctx, None, host=True, type="judge", player_id=imp, correct=False)
    assert s["r"]["phase"] == "result"
    assert s["scores"][str(imp)] == 0 and all(
        s["scores"][str(i)] == 1 for i in s["ids"] if i != imp
    )
    reveal = E.view(s, ctx, Viewer(None))["reveal"]
    assert reveal["imposters"] == [imp] and reveal["word"] == "Giraffe"


def test_exact_guess_counts_automatically_and_accents_are_ignored():
    ctx, s = make()
    s["words"][0] = {"id": 99, "text": "Crème brûlée", "deck": "Food", "emoji": "🍮"}
    s["r"]["word"] = s["words"][0]
    s = to_vote(s, ctx)
    imp = s["r"]["imposters"][0]
    for p in s["ids"]:
        s = act(
            s,
            ctx,
            p,
            type="vote",
            targets=[imp if p != imp else s["ids"][0] if s["ids"][0] != imp else s["ids"][1]],
        )
    s = act(s, ctx, imp, type="guess", text="creme brulee")
    assert s["r"]["phase"] == "result" and s["scores"][str(imp)] == 1
    assert norm("Crème Brûlée!") == "cremebrulee"


def test_imposter_escapes_and_tie_goes_to_runoff_once():
    ctx, s = make(n=4)
    s = to_vote(s, ctx)
    imp = s["r"]["imposters"][0]
    crew = [i for i in s["ids"] if i != imp]
    a, b = crew[0], crew[1]
    # 2 votes for a, 2 votes for b -> tie -> runoff between a and b
    votes = {imp: a, crew[2]: b, a: b, b: a}
    for p, t in votes.items():
        s = act(s, ctx, p, type="vote", targets=[t])
    r = s["r"]
    assert r["phase"] == "vote" and r["runoff"] and sorted(r["candidates"]) == sorted([a, b])
    with pytest.raises(ActionError):
        act(s, ctx, imp, type="vote", targets=[imp])  # not a candidate
    for p, t in {imp: a, crew[2]: b, a: b, b: a}.items():  # still tied -> nobody caught
        s = act(s, ctx, p, type="vote", targets=[t])
    assert s["r"]["phase"] == "result" and s["scores"][str(imp)] == 2


def test_rounds_finish_and_result():
    ctx, s = make(rounds=1)
    s = to_vote(s, ctx)
    imp = s["r"]["imposters"][0]
    wrong = next(i for i in s["ids"] if i != imp)
    for p in s["ids"]:
        s = act(s, ctx, p, type="vote", targets=[wrong if p != wrong else imp])
    assert E.view(s, ctx, Viewer(None))["last_round"]
    with pytest.raises(ActionError):
        act(s, ctx, None, host=True, type="next_round")
    assert E.result(s, ctx) is None
    s = act(s, ctx, None, host=True, type="finish")
    res = E.result(s, ctx)
    assert {x["player_id"]: x["score"] for x in res["scores"]}[imp] == 2
    assert (
        res["word_plays"][0]["result"] == "pass" and "escaped 1 time" in res["details"]["summary"]
    )


def test_two_imposters_capped_by_players():
    ctx, s = make(n=4, imposters=2)
    assert s["n_imp"] == 1  # 4 players: crew must stay the majority
    ctx, s = make(n=6, imposters=2)
    assert s["n_imp"] == 2 and len(s["r"]["imposters"]) == 2


def test_spectator_headline_reveals_only_at_the_end():
    ctx, s = make()
    word = s["r"]["word"]["text"]
    assert word not in E.view(s, ctx, Viewer(None))["headline"]
    s = to_vote(s, ctx)
    imp = s["r"]["imposters"][0]
    other = next(i for i in s["ids"] if i != imp)
    for p in s["ids"]:
        s = act(s, ctx, p, type="vote", targets=[other if p != other else imp])
    head = E.view(s, ctx, Viewer(None))["headline"]
    assert head.startswith("Got away") and word in head
