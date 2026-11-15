import json
import random

import pytest

from app.engines import ActionError, Actor, Ctx, Viewer
from app.engines.popular_opinion import PopularOpinionEngine, questions

E = PopularOpinionEngine()


def make(n=4, **settings):
    players = [{"id": i, "name": f"P{i}", "emoji": "🙂", "team_idx": None} for i in range(1, n + 1)]
    ctx = Ctx(
        1,
        "solo",
        {"rounds": 2, "spicy": False, "show_names": True, **settings},
        players,
        [],
        rng=random.Random(5),
    )
    return ctx, json.loads(json.dumps(E.setup(ctx)))


def act(state, ctx, who, host=False, **action):
    state = json.loads(json.dumps(state))
    return json.loads(json.dumps(E.act(state, ctx, Actor(who, host), action)))


def test_content_and_spicy_filter():
    qs = questions()
    assert len([q for q in qs if not q["spicy"]]) >= 60 and len([q for q in qs if q["spicy"]]) >= 30
    assert all(2 <= len(q["options"]) <= 4 for q in qs)
    _, s = make()
    assert not any(qs[i]["spicy"] for i in s["order"])
    _, s = make(spicy=True)
    assert any(qs[i]["spicy"] for i in s["order"])


def test_round_scoring_ties_and_lone_wolf():
    ctx, s = make()
    s["r"]["q"] = next(
        i for i, q in enumerate(questions()) if len(q["options"]) >= 3 and not q["spicy"]
    )
    # answers: 0,0,1,2 -> majority option 0; P4 alone on option 2 = lone wolf
    for pid, a, g in ((1, 0, 0), (2, 0, 1), (3, 1, 0), (4, 2, 2)):
        s = act(s, ctx, pid, type="answer", option=a)
        assert s["r"]["phase"] == "answer"
        s = act(s, ctx, pid, type="guess", option=g)
    r = s["r"]
    assert r["phase"] == "reveal" and r["majority"] == [0]
    assert s["scores"] == {"1": 1, "2": 0, "3": 1, "4": 0}
    v = E.view(s, ctx, Viewer(2))
    assert v["reveal"]["counts"][:3] == [2, 1, 1] and set(v["reveal"]["wolves"]) == {3, 4}
    assert v["reveal"]["who"]["0"] == [1, 2]
    # tie: 2 vs 2 -> both options count
    s = act(s, ctx, None, host=True, type="next")
    for pid, a in ((1, 0), (2, 0), (3, 1), (4, 1)):
        s = act(s, ctx, pid, type="answer", option=a)
        s = act(s, ctx, pid, type="guess", option=1)
    assert s["r"]["majority"] == [0, 1] and s["scores"]["2"] == 1
    s = act(s, ctx, None, host=True, type="next")
    assert s["finished"] and E.result(s, ctx)["details"]["summary"] == "2 questions"


def test_privacy_and_host_rules():
    ctx, s = make(show_names=False)
    s = act(s, ctx, 1, type="answer", option=0)
    v2 = E.view(s, ctx, Viewer(2))
    assert v2["my_answer"] is None and "answers" not in json.dumps(v2)
    with pytest.raises(ActionError):
        act(s, ctx, 1, type="answer", option=9)
    with pytest.raises(ActionError):
        act(s, ctx, 2, type="reveal")
    s = act(s, ctx, None, host=True, type="reveal")  # early reveal with one answer
    v = E.view(s, ctx, Viewer(3))
    assert v["reveal"]["who"] is None and v["reveal"]["wolves"] == []
    with pytest.raises(ActionError):
        act(s, ctx, 1, type="answer", option=1)  # closed


def test_only_on_everyones_phones(admin, players):
    c = admin
    r = c.post("/api/sessions", json={"game_id": "popular-opinion", "player_ids": players[:3]})
    assert r.status_code == 400
    r = c.post(
        "/api/sessions",
        json={"game_id": "popular-opinion", "player_ids": players[:3], "device_mode": "multi"},
        headers={"X-Device-Id": "po-host-phone"},
    )
    assert r.status_code == 200 and r.json()["status"] == "lobby"
