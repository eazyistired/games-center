"""Tuned In multi-phone rules (state round-trips through JSON like on the server)."""

import json
import random

import pytest

from app.engines import ActionError, Actor, Ctx, Viewer
from app.engines.tuned_in import TunedInEngine, points_for

E = TunedInEngine()


def make(**settings):
    players = [
        {"id": i, "name": f"P{i}", "emoji": "🙂", "team_idx": (i - 1) // 2} for i in range(1, 5)
    ]
    teams = [
        {"idx": 0, "name": "Red", "color": "#d9452b", "player_ids": [1, 2]},
        {"idx": 1, "name": "Blue", "color": "#3d8fd6", "player_ids": [3, 4]},
    ]
    ctx = Ctx(
        1,
        "teams",
        {"play_to": 4, "bet": True, "swaps": 1, **settings},
        players,
        teams,
        rng=random.Random(7),
    )
    return ctx, json.loads(json.dumps(E.setup(ctx)))


def act(state, ctx, who, host=False, **action):
    state = json.loads(json.dumps(state))
    return json.loads(json.dumps(E.act(state, ctx, Actor(who, host), action)))


def view(state, ctx, who, host=False):
    return E.view(state, ctx, Viewer(who, host))


def test_only_the_clue_giver_sees_the_target():
    ctx, s = make()
    assert s["t"]["giver"] == 1
    assert view(s, ctx, 1)["target"] is not None and view(s, ctx, 1)["card"]
    for other in (2, 3, None):
        v = view(s, ctx, other)
        assert v["target"] is None and v["card"] is None  # not even the card before the clue
    assert view(s, ctx, None)["dial"]["target"] is None


def test_swap_and_permissions():
    ctx, s = make()
    with pytest.raises(ActionError):
        act(s, ctx, 2, type="swap")
    card = s["t"]["card"]
    s = act(s, ctx, 1, type="swap")
    assert s["t"]["card"] != card
    with pytest.raises(ActionError, match="No swaps"):
        act(s, ctx, 1, type="swap")
    s = act(s, ctx, 1, type="clue_ready")
    with pytest.raises(ActionError):
        act(s, ctx, 1, type="needle", value=0.3)  # the giver can't move it
    with pytest.raises(ActionError):
        act(s, ctx, 3, type="needle", value=0.3)  # other team can't either
    s = act(s, ctx, 2, type="needle", value=1.7)
    assert s["t"]["needle"] == 1.0 and view(s, ctx, 4)["needle"] == 1.0
    assert view(s, ctx, 2)["can_move"] and not view(s, ctx, 3)["can_move"]


def play_turn(s, ctx, aim_offset, bet_side=None):
    t = s["t"]
    giver, team = t["giver"], t["team"]
    mover = next(i for i in ctx.teams[team]["player_ids"] if i != giver)
    s = act(s, ctx, giver, type="clue_ready")
    s = act(s, ctx, mover, type="needle", value=t["target"] + aim_offset)
    s = act(s, ctx, mover, type="lock")
    if bet_side:
        better = ctx.teams[1 - team]["player_ids"][0]
        s = act(s, ctx, better, type="bet", side=bet_side)
    return s


def test_scoring_bets_and_bullseye_rule():
    assert [points_for(d) for d in (0.0, 0.035, 0.05, 0.1, 0.15, 0.3)] == [4, 4, 3, 3, 2, 0]
    ctx, s = make()
    s = play_turn(s, ctx, 0.0, bet_side="left")  # bullseye: the bet can't win
    assert s["t"]["phase"] == "reveal" and s["scores"] == {"0": 4, "1": 0}
    assert view(s, ctx, 3)["target"] is not None  # everyone sees it now
    with pytest.raises(ActionError):
        act(s, ctx, 3, type="next")  # only the giver or the host continues
    s = act(s, ctx, 1, type="next")
    assert s["t"]["team"] == 1 and s["t"]["giver"] == 3
    # Blue misses by 0.1 to the right of the target -> target is left of the needle
    s = play_turn(s, ctx, 0.1, bet_side="left")
    assert s["scores"] == {"0": 5, "1": 3}  # Blue +3, Red's bet +1
    s = act(s, ctx, 3, type="next")
    assert s["finished"]  # equal turns, Red 5 >= 4 and alone on top
    res = E.result(s, ctx)
    assert {x["team"]: x["score"] for x in res["scores"]} == {0: 5, 1: 3}


def test_no_bets_when_disabled_and_host_controls():
    ctx, s = make(bet=False)
    s = play_turn(s, ctx, 0.5)
    assert s["t"]["phase"] == "reveal"
    with pytest.raises(ActionError):
        act(s, ctx, 2, type="finish")
    s = act(s, ctx, None, host=True, type="finish")
    assert E.result(s, ctx) is not None


def test_over_the_api_target_stays_private(admin, players):
    import json as _json

    c = admin
    phones = [{"X-Device-Id": f"tuned-phone-{i}"} for i in range(4)]
    for h, pid in zip(phones, players[:4], strict=True):
        c.put("/api/devices/me", json={"player_id": pid}, headers=h)
    teams = [{"player_ids": players[:2]}, {"player_ids": players[2:4]}]
    s = c.post(
        "/api/sessions",
        json={"game_id": "tuned-in", "mode": "teams", "teams": teams, "device_mode": "multi"},
        headers=phones[0],
    ).json()
    sid = s["id"]
    for h, pid in zip(phones[1:], players[1:4], strict=True):
        c.post(f"/api/sessions/{sid}/seat", json={"player_id": pid}, headers=h)
    r = c.post(f"/api/sessions/{sid}/start", headers=phones[0]).json()
    target = r["view"]["target"]  # phone 0 = first clue-giver
    assert target is not None and r["progress"] is None
    for h in phones[1:]:
        other = c.get(f"/api/sessions/{sid}", headers=h).json()
        assert other["view"]["target"] is None and str(target) not in _json.dumps(other)
    c.post(f"/api/sessions/{sid}/act", json={"type": "clue_ready"}, headers=phones[0])
    c.post(f"/api/sessions/{sid}/act", json={"type": "needle", "value": 0.25}, headers=phones[1])
    tv = c.get(f"/api/sessions/{sid}", headers={"X-Device-Id": "tv-screen-1"}).json()
    assert tv["watch"]["dial"]["needle"] == 0.25 and tv["watch"]["dial"]["target"] is None
