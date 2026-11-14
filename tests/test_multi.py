import json
from pathlib import Path

import pytest

from app.db import SessionLocal
from app.services import registry

FIX = Path(__file__).parent / "fixtures" / "games" / "demo-multi"
H = {"X-Device-Id": "host-phone-1"}
P2 = {"X-Device-Id": "player-two-2"}
P3 = {"X-Device-Id": "player-three-3"}
SPY = {"X-Device-Id": "spectator-9"}


@pytest.fixture()
def demo(admin, players):
    import tests.fixtures.demo_engine  # noqa: F401  (registers the engine)

    registry.GAMES["demo-multi"] = {
        **registry.MANIFEST_DEFAULTS,
        **json.loads((FIX / "manifest.json").read_text()),
    }
    with SessionLocal() as db:
        registry.sync_games(db)
        db.commit()
    admin.put("/api/devices/me", json={"player_id": players[0]}, headers=H)
    yield admin, players
    registry.GAMES.pop("demo-multi", None)


def create(c, players, headers=H, **kw):
    body = {"game_id": "demo-multi", "player_ids": players[:3], "device_mode": "multi"} | kw
    return c.post("/api/sessions", json=body, headers=headers)


def test_multi_needs_engine_and_device(demo):
    c, players = demo
    assert create(c, players, headers={}).status_code == 400  # no device id
    r = c.post(
        "/api/sessions",
        json={"game_id": "heads-up", "player_ids": players[:3], "device_mode": "multi"},
        headers=H,
    )
    assert r.status_code == 400 and "can't be played" in r.json()["detail"]


def test_lobby_seats_and_start(demo):
    c, players = demo
    s = create(c, players).json()
    assert s["status"] == "lobby" and s["live_status"] == "lobby"
    lobby = s["lobby"]
    assert lobby["is_host"] and lobby["my_seat"] == players[0]  # host auto-seated (identity)
    assert not lobby["all_joined"]
    sid = s["id"]
    assert c.get("/api/sessions/live", headers=P2).json()[0]["id"] == sid  # visible in Live now
    # only the host may start, and only when everyone has joined
    assert c.post(f"/api/sessions/{sid}/start", headers=P2).status_code == 403
    r = c.post(f"/api/sessions/{sid}/start", headers=H)
    assert r.status_code == 400 and "Waiting for" in r.json()["detail"]["message"]
    r = c.post(f"/api/sessions/{sid}/seat", json={"player_id": players[1]}, headers=P2).json()
    assert r["lobby"]["my_seat"] == players[1] and r["lobby"]["is_host"] is False
    # claiming a seat sets "who am I" on that phone
    hb = c.post("/api/devices/heartbeat", json={}, headers=P2).json()
    assert hb["device"]["player"]["id"] == players[1]
    # a seat held by an active phone can't be grabbed (except by the host, forcing)
    r = c.post(f"/api/sessions/{sid}/seat", json={"player_id": players[1]}, headers=P3)
    assert r.status_code == 409 and r.json()["detail"]["seat_taken"]
    c.post(f"/api/sessions/{sid}/seat", json={"player_id": players[2]}, headers=P3)
    # leaving: yourself or the host
    assert c.delete(f"/api/sessions/{sid}/seat/{players[1]}", headers=P3).status_code == 403
    c.delete(f"/api/sessions/{sid}/seat/{players[2]}", headers=P3)
    c.post(f"/api/sessions/{sid}/seat", json={"player_id": players[2]}, headers=P3)
    r = c.post(f"/api/sessions/{sid}/start", headers=H).json()
    assert r["status"] == "active" and r["lobby"]["all_joined"]


def started(c, players):
    sid = create(c, players).json()["id"]
    c.post(f"/api/sessions/{sid}/seat", json={"player_id": players[1]}, headers=P2)
    c.post(f"/api/sessions/{sid}/seat", json={"player_id": players[2]}, headers=P3)
    c.post(f"/api/sessions/{sid}/start", headers=H)
    return sid


def test_views_keep_secrets(demo):
    c, players = demo
    sid = started(c, players)
    mine = c.get(f"/api/sessions/{sid}", headers=P2).json()
    assert mine["progress"] is None  # raw engine state never leaves the server
    assert mine["view"]["my_secret"] == "banana"
    assert c.get(f"/api/sessions/{sid}", headers=H).json()["view"]["my_secret"] == "apple"
    spy = c.get(f"/api/sessions/{sid}", headers=SPY).json()
    assert "my_secret" not in spy["view"] and "secret" not in json.dumps(spy)
    assert spy["watch"]["headline"].startswith("Round 1")


def test_actions_and_result(demo):
    c, players = demo
    sid = started(c, players)
    assert c.post(f"/api/sessions/{sid}/act", json={"type": "tap"}, headers=SPY).status_code == 403
    r = c.post(f"/api/sessions/{sid}/act", json={"type": "reset"}, headers=P2)
    assert r.status_code == 400 and "host" in r.json()["detail"]["message"]
    assert c.post(f"/api/sessions/{sid}/act", json={"type": "nope"}, headers=P2).status_code == 400
    for _ in range(2):
        c.post(f"/api/sessions/{sid}/act", json={"type": "tap"}, headers=P2)
    r = c.get(f"/api/sessions/{sid}", headers=SPY).json()
    assert {x["name"]: x["score"] for x in r["watch"]["scoreboard"]}["Bogdan"] == 2
    r = c.post(f"/api/sessions/{sid}/act", json={"type": "tap"}, headers=P2).json()
    assert r["status"] == "finished"
    places = {p["player_id"]: p["placement"] for p in r["participants"]}
    assert places[players[1]] == 1
    assert (
        c.get("/api/leaderboards?period=tonight").json()["entries"][0]["player"]["id"] == players[1]
    )


def test_websocket_pushes_personal_views(demo):
    c, players = demo
    sid = started(c, players)
    url = f"/ws?session={sid}&device={P2['X-Device-Id']}"
    with c.websocket_connect(url) as ws, c.websocket_connect("/ws") as live_ws:
        first = ws.receive_json()
        assert first["type"] == "session" and first["session"]["view"]["my_secret"] == "banana"
        c.post(f"/api/sessions/{sid}/act", json={"type": "tap"}, headers=P3)
        # the live list gets a nudge, the session room gets fresh personal payloads
        assert live_ws.receive_json()["type"] == "live"
        for _ in range(5):
            msg = ws.receive_json()
            board = {x["name"]: x["score"] for x in msg["session"]["view"]["scoreboard"]}
            if board["Cata"] == 1:
                break
        assert board["Cata"] == 1 and msg["session"]["view"]["my_secret"] == "banana"
        ws.send_text("ping")
        while ws.receive_json()["type"] != "pong":
            pass


def test_summary_keeps_device_mode(demo):
    c, players = demo
    sid = started(c, players)
    for _ in range(3):
        c.post(f"/api/sessions/{sid}/act", json={"type": "tap"}, headers=P2)
    summary = c.get(f"/api/sessions/{sid}/summary", headers=P2).json()["session"]
    assert summary["device_mode"] == "multi" and summary["status"] == "finished"
