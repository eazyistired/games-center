import json
from datetime import timedelta
from pathlib import Path

import pytest

from app.db import SessionLocal
from app.models import Device, GameSession, utcnow
from app.services import registry

A = {"X-Device-Id": "names-phone-aa"}
B = {"X-Device-Id": "names-phone-bb"}
C = {"X-Device-Id": "names-phone-cc"}


def age(device, minutes):
    with SessionLocal() as db:
        db.get(Device, device["X-Device-Id"]).last_seen = utcnow() - timedelta(minutes=minutes)
        db.commit()


def me(c, h):
    return c.post("/api/devices/heartbeat", json={}, headers=h).json()


def test_free_name_and_in_use_flag(admin, players):
    c = admin
    r = c.put("/api/devices/me", json={"player_id": players[0]}, headers=A).json()
    assert r["status"] == "granted" and r["player"]["id"] == players[0]
    flags = {p["id"]: p["in_use"] for p in c.get("/api/players", headers=B).json()}
    assert flags[players[0]] is True and flags[players[1]] is False
    mine = {p["id"]: p["in_use"] for p in c.get("/api/players", headers=A).json()}
    assert mine[players[0]] is False  # your own name isn't "in use elsewhere"


def test_active_owner_must_allow(admin, players):
    c = admin
    c.put("/api/devices/me", json={"player_id": players[0]}, headers=A)
    r = c.put("/api/devices/me", json={"player_id": players[0]}, headers=B).json()
    assert r["status"] == "pending" and r["player"]["id"] == players[0]
    assert me(c, B)["device"]["player"] is None  # not yours yet
    reqs = me(c, A)["requests"]
    assert reqs[0]["reason"] == "name" and reqs[0]["decide_url"].endswith("/decide")
    c.post(reqs[0]["decide_url"], json={"approve": True}, headers=A)
    st = c.get(f"/api/identity-requests/{r['request_id']}", headers=B).json()
    assert st["status"] == "granted" and st["device"]["player"]["id"] == players[0]
    assert me(c, A)["device"]["player"] is None  # the old phone lost the name


def test_denials_then_cooldown(admin, players):
    c = admin
    c.put("/api/devices/me", json={"player_id": players[0]}, headers=A)
    for tries_left in (2, 1, 0):
        rid = c.put("/api/devices/me", json={"player_id": players[0]}, headers=B).json()[
            "request_id"
        ]
        c.post(f"/api/identity-requests/{rid}/decide", json={"approve": False}, headers=A)
        st = c.get(f"/api/identity-requests/{rid}", headers=B).json()
        assert st["status"] == "denied" and st["tries_left"] == tries_left
    assert st["cooldown_seconds"] > 290
    r = c.put("/api/devices/me", json={"player_id": players[0]}, headers=B)
    assert r.status_code == 429 and r.json()["detail"]["cooldown_seconds"] > 290
    # someone else's name is still fine
    assert (
        c.put("/api/devices/me", json={"player_id": players[1]}, headers=B).json()["status"]
        == "granted"
    )


def test_quiet_owner_releases_after_hold_time(admin, players):
    c = admin
    c.put("/api/devices/me", json={"player_id": players[0]}, headers=A)
    age(A, 25)
    assert (
        c.put("/api/devices/me", json={"player_id": players[0]}, headers=B).json()["status"]
        == "pending"
    )
    age(A, 31)  # beyond the 30 min hold: moves without asking (also for the pending request)
    assert (
        c.put("/api/devices/me", json={"player_id": players[0]}, headers=B).json()["status"]
        == "granted"
    )
    c.put("/api/admin/settings", json={"name_hold_minutes": 60})
    c.put("/api/devices/me", json={"player_id": players[1]}, headers=A)
    age(A, 45)
    assert (
        c.put("/api/devices/me", json={"player_id": players[1]}, headers=C).json()["status"]
        == "pending"
    )
    assert c.put("/api/admin/settings", json={"name_hold_minutes": 0}).status_code == 400


def test_admin_release(admin, players):
    c = admin
    c.put("/api/devices/me", json={"player_id": players[0]}, headers=A)
    row = next(p for p in c.get("/api/admin/players").json() if p["id"] == players[0])
    assert row["phone_seen"] is not None
    assert c.post(f"/api/admin/players/{players[0]}/release").json()["released"] == 1
    assert (
        c.put("/api/devices/me", json={"player_id": players[0]}, headers=B).json()["status"]
        == "granted"
    )


# ---------------------------------------------------------------- multi-phone host + seats

FIX = Path(__file__).parent / "fixtures" / "games" / "demo-multi"


@pytest.fixture()
def lobby(admin, players):
    import tests.fixtures.demo_engine  # noqa: F401

    registry.GAMES["demo-multi"] = {
        **registry.MANIFEST_DEFAULTS,
        **json.loads((FIX / "manifest.json").read_text()),
    }
    with SessionLocal() as db:
        registry.sync_games(db)
        db.commit()
    c = admin
    c.put("/api/devices/me", json={"player_id": players[0]}, headers=A)
    s = c.post(
        "/api/sessions",
        json={"game_id": "demo-multi", "player_ids": players[:3], "device_mode": "multi"},
        headers=A,
    ).json()
    c.post(f"/api/sessions/{s['id']}/seat", json={"player_id": players[1]}, headers=B)
    yield c, players, s["id"]
    registry.GAMES.pop("demo-multi", None)


def host_of(c, sid, h):
    return c.get(f"/api/sessions/{sid}", headers=h).json()["lobby"]["is_host"]


def test_seat_claim_respects_names(lobby):
    c, players, sid = lobby
    r = c.post(f"/api/sessions/{sid}/seat", json={"player_id": players[1]}, headers=C)
    assert r.status_code == 409  # Bogdan is joined on phone B
    # once the name moves (B allows), the seat moves along
    rid = c.put("/api/devices/me", json={"player_id": players[1]}, headers=C).json()["request_id"]
    c.post(f"/api/identity-requests/{rid}/decide", json={"approve": True}, headers=B)
    c.get(f"/api/identity-requests/{rid}", headers=C)
    assert c.get(f"/api/sessions/{sid}", headers=C).json()["lobby"]["my_seat"] == players[1]
    assert c.get(f"/api/sessions/{sid}", headers=B).json()["lobby"]["my_seat"] is None


def test_hand_over_host(lobby):
    c, players, sid = lobby
    assert host_of(c, sid, A) and not host_of(c, sid, B)
    assert (
        c.post(f"/api/sessions/{sid}/host", json={"player_id": players[0]}, headers=B).status_code
        == 403
    )
    assert (
        c.post(f"/api/sessions/{sid}/host", json={"player_id": players[2]}, headers=A).status_code
        == 400
    )  # not joined
    r = c.post(f"/api/sessions/{sid}/host", json={"player_id": players[1]}, headers=A).json()
    assert r["lobby"]["is_host"] is False and host_of(c, sid, B)
    # host leaving the lobby passes the crown on
    c.post(f"/api/sessions/{sid}/seat", json={"player_id": players[2]}, headers=C)
    c.delete(f"/api/sessions/{sid}/seat/{players[1]}", headers=B)
    assert host_of(c, sid, A) or host_of(c, sid, C)


def test_gone_host_is_replaced(lobby):
    from app.realtime import hub
    from app.services.multi import reassign_if_host_gone

    c, players, sid = lobby
    with SessionLocal() as db:
        s = db.get(GameSession, sid)
        assert reassign_if_host_gone(db, s, set()) is False  # host phone still fresh
    age(A, 5)
    with SessionLocal() as db:
        s = db.get(GameSession, sid)
        assert reassign_if_host_gone(db, s, hub.online_devices(sid)) is True
        db.commit()
    assert host_of(c, sid, B)


def test_become_host_needs_active_host_ok(lobby):
    c, players, sid = lobby
    c.post(f"/api/sessions/{sid}/heartbeat", headers=A)  # host active
    assert c.post(f"/api/sessions/{sid}/takeover", headers=C).status_code == 403  # not joined
    r = c.post(f"/api/sessions/{sid}/takeover", headers=B).json()
    assert r["status"] == "pending"
    req = c.get(f"/api/sessions/{sid}", headers=A).json()["requests"]
    assert req[0]["host"] is True
    c.post(req[0]["decide_url"], json={"approve": True}, headers=A)
    assert c.get(f"/api/sessions/{sid}/takeover", headers=B).json()["status"] == "granted"
    assert host_of(c, sid, B)
