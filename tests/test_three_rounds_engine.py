"""Three Rounds multi-phone rules, with a fake clock; state round-trips through JSON."""

import json
import random

import pytest

import app.engines.three_rounds as tr
from app.engines import ActionError, Actor, Ctx, Viewer

E = tr.ThreeRoundsEngine()
WORDS = [{"id": i, "text": f"word{i}", "deck": "Test", "emoji": "🧪"} for i in range(1, 7)]


class Clock:
    t = 1000.0


@pytest.fixture(autouse=True)
def fake_clock(monkeypatch):
    Clock.t = 1000.0
    monkeypatch.setattr(tr, "now", lambda: Clock.t)


def make(**settings):
    players = [
        {"id": i, "name": f"P{i}", "emoji": "🙂", "team_idx": (i - 1) // 2} for i in range(1, 5)
    ]
    teams = [
        {"idx": 0, "name": "Red", "color": "#d9452b", "player_ids": [1, 2]},
        {"idx": 1, "name": "Blue", "color": "#3d8fd6", "player_ids": [3, 4]},
    ]
    base = {"turn_seconds": 30, "skips": 1, "words_per_player": 2}
    ctx = Ctx(
        1,
        "teams",
        base | settings,
        players,
        teams,
        draw_words=lambda n: WORDS[:n],
        rng=random.Random(3),
    )
    return ctx, json.loads(json.dumps(E.setup(ctx)))


def act(state, ctx, who, host=False, **action):
    state = json.loads(json.dumps(state))
    return json.loads(json.dumps(E.act(state, ctx, Actor(who, host), action)))


def view(state, ctx, who, host=False):
    return E.view(state, ctx, Viewer(who, host))


def started(s, ctx):
    s = act(s, ctx, s["t"]["giver"], type="start")
    Clock.t += 3.1
    return s


def test_only_the_clue_giver_gets_the_word():
    ctx, s = make()
    assert s["t"]["giver"] == 1 and len(s["words"]) == 6
    with pytest.raises(ActionError):
        act(s, ctx, 3, type="start")
    s = started(s, ctx)
    word = view(s, ctx, 1)["word"]["text"]
    for other in (2, 3, None):
        assert word not in json.dumps(view(s, ctx, other))
    assert view(s, ctx, 2)["ends_in"] == pytest.approx(29.9, abs=0.2)
    with pytest.raises(ActionError):
        act(s, ctx, 2, type="got")  # a teammate can't tap for the giver


def test_turn_skips_timeout_and_review():
    ctx, s = make()
    s = act(s, ctx, 1, type="start")
    with pytest.raises(ActionError, match="countdown"):
        act(s, ctx, 1, type="got")
    Clock.t += 3.1
    s = act(s, ctx, 1, type="got")
    s = act(s, ctx, 1, type="skip")
    with pytest.raises(ActionError, match="No skips"):
        act(s, ctx, 1, type="skip")
    with pytest.raises(ActionError, match="still time"):
        act(s, ctx, 1, type="time_up")
    Clock.t += 30
    s = act(s, ctx, 1, type="time_up")
    t = s["t"]
    assert t["phase"] == "review" and [i["kind"] for i in t["items"]] == [
        "correct",
        "skip",
        "timeout",
    ]
    assert view(s, ctx, 1)["items"][2]["correct"] is False and "items" not in view(s, ctx, 3)
    s = act(s, ctx, 1, type="toggle", index=2)  # the timed-out word was guessed at the buzzer
    s = act(s, ctx, 1, type="confirm")
    assert s["scores"] == {"0": 2, "1": 0} and len(s["remaining"]) == 3  # 6 - 2 correct - 1 skipped
    assert len(s["discarded"]) == 1 and s["t"]["team"] == 1 and s["t"]["giver"] == 3


def test_late_tap_ends_the_turn_and_pause_resume():
    ctx, s = make()
    s = started(s, ctx)
    s = act(s, ctx, 1, type="pause")
    assert s["t"]["phase"] == "paused" and s["t"]["left"] == pytest.approx(29.9, abs=0.2)
    Clock.t += 100  # paused time doesn't count
    s = act(s, ctx, None, host=True, type="resume")
    Clock.t += 3.1
    assert view(s, ctx, 3)["ends_in"] == pytest.approx(29.9, abs=0.2)
    Clock.t += 32  # past the buzzer + grace: the tap ends the turn instead
    s = act(s, ctx, 1, type="got")
    assert s["t"]["phase"] == "review" and s["t"]["items"][0]["kind"] == "timeout"


def test_hat_empties_carry_over_and_three_rounds():
    ctx, s = make(skips=99)
    s = started(s, ctx)
    for _ in range(6):
        s = act(s, ctx, 1, type="got")
        Clock.t += 1
    assert s["t"]["phase"] == "review" and s["t"]["reason"] == "pool"
    s = act(s, ctx, 1, type="confirm")
    assert s["round"] == 1 and s["new_round"] and s["t"]["carried"]
    assert s["t"]["giver"] == 1 and s["t"]["seconds"] == pytest.approx(
        24.9, abs=0.05
    )  # 30 s - 5.1 s used
    for _ in range(2):  # rounds 2 and 3 cleared by the same team in one go
        s = started(s, ctx)
        for _ in range(6):
            s = act(s, ctx, s["t"]["giver"], type="got")
        s = act(s, ctx, s["t"]["giver"], type="confirm")
    assert s["finished"] and s["scores"] == {"0": 18, "1": 0}
    res = E.result(s, ctx)
    assert "18 words" in res["details"]["summary"] and len(res["word_plays"]) == 18


def test_host_controls():
    ctx, s = make()
    s = started(s, ctx)
    with pytest.raises(ActionError):
        act(s, ctx, 3, type="end_turn")
    s = act(s, ctx, None, host=True, type="end_turn")  # the clue-giver's phone vanished
    s = act(s, ctx, None, host=True, type="confirm")
    assert s["t"]["giver"] == 3
    s = act(s, ctx, None, host=True, type="finish")
    assert E.result(s, ctx)["scores"] == [{"team": 0, "score": 0}, {"team": 1, "score": 0}]
