from datetime import timedelta

from app.db import SessionLocal
from app.models import Device, GameSession, utcnow

A = {"X-Device-Id": "device-aaaaaaaa"}
B = {"X-Device-Id": "device-bbbbbbbb"}
C = {"X-Device-Id": "device-cccccccc"}


def new_session(c, players, headers=A):
    r = c.post(
        "/api/sessions", json={"game_id": "heads-up", "player_ids": players[:3]}, headers=headers
    )
    assert r.status_code == 200, r.text
    return r.json()


def age_device(device_id, seconds=120):
    with SessionLocal() as db:
        d = db.get(Device, device_id)
        d.last_seen = utcnow() - timedelta(seconds=seconds)
        db.commit()


def age_controller(session_id, seconds=120):
    with SessionLocal() as db:
        s = db.get(GameSession, session_id)
        s.controller_seen_at = utcnow() - timedelta(seconds=seconds)
        db.commit()


def test_identity_and_heartbeat(admin, players):
    c = admin
    assert c.post("/api/devices/heartbeat", json={}).status_code == 400  # no device id
    r = c.post("/api/devices/heartbeat", json={"label": "iPhone"}, headers=A).json()
    assert r["device"]["player"] is None and r["requests"] == []
    r = c.put("/api/devices/me", json={"player_id": players[0]}, headers=A).json()
    assert r["player"]["id"] == players[0]
    assert c.put("/api/devices/me", json={"player_id": 9999}, headers=A).status_code == 400
    assert c.get("/api/qr.svg?data=https://games.grzv.local").text.startswith("<?xml")


def test_creator_controls_and_others_are_blocked(admin, players):
    c = admin
    s = new_session(c, players)
    assert s["controlled_by_me"]  # the creating phone controls the session
    assert c.get(f"/api/sessions/{s['id']}").json()["controlled_by_me"] is False
    s = c.get(f"/api/sessions/{s['id']}", headers=A).json()
    assert s["controlled_by_me"] and s["live_status"] == "playing"
    sid = s["id"]
    # B can't save, finish, abandon or claim while A is active
    r = c.put(f"/api/sessions/{sid}/progress", json={"state": {"x": 1}}, headers=B)
    assert r.status_code == 409 and r.json()["detail"]["lost"]
    assert c.post(f"/api/sessions/{sid}/result", json={"scores": []}, headers=B).status_code == 409
    assert c.post(f"/api/sessions/{sid}/abandon", headers=B).status_code == 403  # host only
    r = c.post(f"/api/sessions/{sid}/control", headers=B)
    assert r.status_code == 409 and r.json()["detail"]["needs_takeover"]
    # A saves with versions
    v = c.put(f"/api/sessions/{sid}/progress", json={"state": {"t": 1}, "version": 0}, headers=A)
    assert v.json()["version"] == 1
    stale = c.put(
        f"/api/sessions/{sid}/progress", json={"state": {"t": 2}, "version": 0}, headers=A
    )
    assert stale.status_code == 409


def test_takeover_needs_controller_approval(admin, players):
    c = admin
    sid = new_session(c, players)["id"]
    c.post(f"/api/sessions/{sid}/heartbeat", headers=A)
    r = c.post(f"/api/sessions/{sid}/takeover", headers=B).json()
    assert r["status"] == "pending" and r["waiting_for"][0]["reason"] == "controller"
    hb = c.post(f"/api/sessions/{sid}/heartbeat", headers=A).json()
    assert hb["in_control"] and len(hb["requests"]) == 1
    rid = hb["requests"][0]["id"]
    assert (
        c.post(f"/api/takeover/{rid}/decide", json={"approve": True}, headers=C).status_code == 404
    )
    c.post(f"/api/takeover/{rid}/decide", json={"approve": False}, headers=A)
    assert c.get(f"/api/sessions/{sid}/takeover", headers=B).json()["status"] == "denied"
    # ask again, this time A allows
    c.post(f"/api/sessions/{sid}/takeover", headers=B)
    rid = c.post(f"/api/sessions/{sid}/heartbeat", headers=A).json()["requests"][0]["id"]
    c.post(f"/api/takeover/{rid}/decide", json={"approve": True}, headers=A)
    assert c.get(f"/api/sessions/{sid}/takeover", headers=B).json()["status"] == "granted"
    hb = c.post(f"/api/sessions/{sid}/heartbeat", headers=A).json()
    assert hb["in_control"] is False  # A now shows "continued on another phone"
    assert c.post(f"/api/sessions/{sid}/heartbeat", headers=B).json()["in_control"]


def test_quiet_controller_is_taken_over_at_once(admin, players):
    c = admin
    sid = new_session(c, players)["id"]
    age_controller(sid)
    s = c.get(f"/api/sessions/{sid}", headers=B).json()
    assert s["live_status"] == "paused"
    assert c.post(f"/api/sessions/{sid}/control", headers=B).status_code == 200
    # quiet approver while pending -> approved automatically
    c.post(f"/api/sessions/{sid}/heartbeat", headers=B)
    assert c.post(f"/api/sessions/{sid}/takeover", headers=C).json()["status"] == "pending"
    age_device(B["X-Device-Id"])
    age_controller(sid, 10)  # controller still "active" by its own timestamp
    assert c.get(f"/api/sessions/{sid}/takeover", headers=C).json()["status"] == "granted"


def test_takeover_needs_other_phone_of_same_name_to_confirm(admin, players):
    """Two phones as the same name can only exist via an approved name move; the takeover rule
    for 'your name is active elsewhere' still holds for legacy duplicates."""
    from app.db import SessionLocal
    from app.models import Device

    c = admin
    sid = new_session(c, players)["id"]
    age_controller(sid)  # session paused: no controller approval needed
    c.put("/api/devices/me", json={"player_id": players[1]}, headers=B)
    c.post("/api/devices/heartbeat", json={}, headers=C)
    with SessionLocal() as db:  # simulate a duplicate created before names were unique
        db.get(Device, C["X-Device-Id"]).player_id = players[1]
        db.commit()
    c.post("/api/devices/heartbeat", json={}, headers=B)
    assert c.post(f"/api/sessions/{sid}/control", headers=C).status_code == 409
    r = c.post(f"/api/sessions/{sid}/takeover", headers=C).json()
    assert r["status"] == "pending" and r["waiting_for"][0]["reason"] == "identity"
    req = c.post("/api/devices/heartbeat", json={}, headers=B).json()["requests"]
    rid = next(x["id"] for x in req if x["reason"] == "identity")
    c.post(f"/api/takeover/{rid}/decide", json={"approve": True}, headers=B)
    assert c.get(f"/api/sessions/{sid}/takeover", headers=C).json()["status"] == "granted"


def test_live_list_and_nights(admin, players):
    c = admin
    s = new_session(c, players)
    live = c.get("/api/sessions/live", headers=A).json()
    assert live[0]["id"] == s["id"] and live[0]["controlled_by_me"]
    nights = c.get("/api/nights").json()
    assert nights[0]["live_count"] == 1
    night = c.get(f"/api/nights/{nights[0]['id']}", headers=A).json()
    assert night["sessions"][0]["live_status"] == "playing"


def test_idle_sessions_auto_finish_or_abandon(admin, players):
    from app.services.live import close_idle_sessions

    c = admin
    s1 = new_session(c, players)["id"]  # no partial scores -> abandoned
    s2 = new_session(c, players)["id"]
    c.put(
        f"/api/sessions/{s2}/progress",
        json={"state": {}, "partial": {"scores": [{"player_id": players[0], "score": 3}]}},
        headers=A,
    )
    s3 = new_session(c, players)["id"]  # recent -> untouched
    for sid in (s1, s2):
        age_controller(sid, 3 * 3600)
    with SessionLocal() as db:
        assert close_idle_sessions(db, 2) == {"finished": 1, "abandoned": 1}
        db.commit()
    get = lambda sid: c.get(f"/api/sessions/{sid}").json()  # noqa: E731
    assert get(s1)["status"] == "abandoned" and get(s3)["status"] == "active"
    done = get(s2)
    assert done["status"] == "finished" and "auto-finished" in done["details"]["summary"]
    assert {p["player_id"]: p["placement"] for p in done["participants"]}[players[0]] == 1


def test_quiet_and_idle_settings(admin, players):
    from app.services import live

    c = admin
    r = c.put("/api/admin/settings", json={"quiet_seconds": 60, "idle_hours": 1.5})
    assert r.status_code == 200 and r.json()["quiet_seconds"] == 60
    assert live.ACTIVE_SECONDS == 60
    sid = new_session(c, players)["id"]
    age_controller(sid, 45)  # quiet for 45 s: still "playing" with a 60 s window
    s = c.get(f"/api/sessions/{sid}", headers=B).json()
    assert s["live_status"] == "playing" and s["quiet_seconds"] == 60 and s["heartbeat_ms"] == 5000
    assert c.put("/api/admin/settings", json={"quiet_seconds": 5}).status_code == 400
    assert c.put("/api/admin/settings", json={"idle_hours": 100}).status_code == 400
    c.put("/api/admin/settings", json={"quiet_seconds": 12})
    assert c.get(f"/api/sessions/{sid}").json()["heartbeat_ms"] == 3000
    c.put("/api/admin/settings", json={"quiet_seconds": 30})


def test_watch_scoreboard_for_one_phone_games(admin, players):
    c = admin
    sid = new_session(c, players)["id"]
    w = c.get(f"/api/sessions/{sid}", headers=C).json()["watch"]
    assert w["scoreboard"] == []  # nothing until the first save with scores
    c.put(
        f"/api/sessions/{sid}/progress",
        json={
            "state": {"secret": "x"},
            "partial": {
                "scores": [
                    {"player_id": players[0], "score": 4},
                    {"player_id": players[1], "score": 1},
                ],
                "details": {"summary": "1 of 3 turns played"},
            },
        },
        headers=A,
    )
    w = c.get(f"/api/sessions/{sid}", headers=C).json()["watch"]
    assert w["headline"] == "1 of 3 turns played"
    assert [r["score"] for r in w["scoreboard"]] == [4, 1]


def test_only_the_host_can_discard(admin, players):
    c = admin
    sid = new_session(c, players)["id"]
    age_controller(sid)  # paused: still only the host's phone may discard it
    assert c.post(f"/api/sessions/{sid}/abandon", headers=B).status_code == 403
    assert c.post(f"/api/sessions/{sid}/abandon", headers=A).json()["status"] == "abandoned"
