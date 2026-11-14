import json

A = {"X-Device-Id": "collect-host-1"}
B = {"X-Device-Id": "collect-bob-22"}
C = {"X-Device-Id": "collect-cat-33"}


def setup_people(c, players):
    for h, pid in ((A, players[0]), (B, players[1]), (C, players[2])):
        c.put("/api/devices/me", json={"player_id": pid}, headers=h)


def new(c, players, game="heads-up", **settings):
    body = {
        "game_id": game,
        "player_ids": players[:3],
        "settings": {"collect_words": True, "collect_per_player": 3, **settings},
    }
    r = c.post("/api/sessions", json=body, headers=A)
    assert r.status_code == 200, r.text
    return r.json()


def test_collecting_flow_and_privacy(admin, players):
    c = admin
    s = new(c, players)
    sid = s["id"]
    assert s["status"] == "collecting" and s["live_status"] == "collecting"
    assert s["collect"]["min_total"] == 4 and s["collect"]["total"] == 0
    assert c.get("/api/sessions/live", headers=B).json()[0]["id"] == sid
    # need to know who you are
    r = c.post(f"/api/sessions/{sid}/words", json={"text": "x"}, headers=A)
    assert r.status_code == 403
    setup_people(c, players)
    r = c.post(
        f"/api/sessions/{sid}/words", json={"text": "Uncle Bob\nThe red car\nuncle bob"}, headers=A
    )
    assert [w["text"] for w in r.json()["collect"]["mine"]] == ["Uncle Bob", "The red car"]
    r = c.post(f"/api/sessions/{sid}/words", json={"text": "Pizza night, Karaoke"}, headers=A)
    assert len(r.json()["collect"]["mine"]) == 3  # limit 3: Karaoke didn't fit
    assert c.post(f"/api/sessions/{sid}/words", json={"text": "more"}, headers=A).status_code == 400
    # others only see counts, never the words
    seen_by_b = c.get(f"/api/sessions/{sid}", headers=B).json()
    assert seen_by_b["collect"]["mine"] == [] and "Uncle Bob" not in json.dumps(seen_by_b)
    counts = {x["player_id"]: x["count"] for x in seen_by_b["collect"]["counts"]}
    assert counts[players[0]] == 3 and counts[players[1]] == 0
    # only your own words can be deleted
    wid = r.json()["collect"]["mine"][0]["id"]
    assert c.delete(f"/api/sessions/{sid}/words/{wid}", headers=B).status_code == 404
    assert c.delete(f"/api/sessions/{sid}/words/{wid}", headers=A).status_code == 200
    # host-only start, and only with enough words
    c.post(f"/api/sessions/{sid}/words", json={"text": "Bob's BBQ\nCamping 2019"}, headers=B)
    assert c.post(f"/api/sessions/{sid}/begin", headers=B).status_code == 403
    r = c.post(f"/api/sessions/{sid}/begin", headers=A)
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["status"] == "active" and "collect" not in s
    assert s["collected_deck"]["saved"] is False and s["collected_deck"]["count"] == 4
    assert c.post(f"/api/sessions/{sid}/words", json={"text": "late"}, headers=C).status_code == 400
    # the game gets exactly the friends' words, with authors
    words = c.get(f"/api/sessions/{sid}/words").json()
    assert sorted(w["text"] for w in words) == [
        "Bob's BBQ",
        "Camping 2019",
        "Pizza night",
        "The red car",
    ]
    assert {w["author"] for w in words} == {players[0], players[1]}
    # the hidden deck shows up nowhere until saved
    deck_id = s["collected_deck"]["id"]
    assert deck_id not in [d["id"] for d in c.get("/api/games/heads-up").json()["decks"]]
    assert deck_id not in [d["id"] for d in c.get("/api/admin/decks").json()]
    # can't save before the game is played... then play and save
    r = c.post(
        f"/api/sessions/{sid}/result",
        json={"scores": [{"player_id": players[0], "score": 2}]},
        headers=A,
    )
    assert r.json()["collected_deck"]["saved"] is False
    assert (
        c.post(f"/api/sessions/{sid}/save-deck", json={"name": " "}, headers=C).status_code == 400
    )
    r = c.post(
        f"/api/sessions/{sid}/save-deck", json={"name": "Our inside jokes"}, headers=C
    ).json()
    assert r["collected_deck"] == {
        "id": deck_id,
        "name": "Our inside jokes",
        "saved": True,
        "count": 4,
    }
    decks = {d["id"]: d for d in c.get("/api/games/heads-up").json()["decks"]}
    assert decks[deck_id]["name"] == "Our inside jokes" and decks[deck_id]["word_count"] == 4
    assert deck_id in [
        d["id"] for d in c.get("/api/games/imposter").json()["decks"]
    ]  # shared decks


def test_summary_and_play_again_settings(admin, players):
    c = admin
    setup_people(c, players)
    sid = new(c, players)["id"]
    c.post(f"/api/sessions/{sid}/words", json={"text": "a\nb\nc"}, headers=A)
    c.post(f"/api/sessions/{sid}/words", json={"text": "d"}, headers=B)
    c.post(f"/api/sessions/{sid}/begin", headers=A)
    c.post(f"/api/sessions/{sid}/result", json={"scores": []}, headers=A)
    summary = c.get(f"/api/sessions/{sid}/summary", headers=B).json()["session"]
    assert summary["collected_deck"]["count"] == 4
    # "play again" sends the old settings back: the hidden deck id must not leak into the new game
    again = c.post(
        "/api/sessions",
        json={"game_id": "heads-up", "player_ids": players[:3], "settings": summary["settings"]},
        headers=A,
    ).json()
    assert again["status"] == "collecting" and "collected_deck" not in again["settings"]


def test_multi_imposter_collects_in_the_lobby_and_author_is_never_imposter(admin, players):
    c = admin
    setup_people(c, players)
    body = {
        "game_id": "imposter",
        "player_ids": players[:3],
        "device_mode": "multi",
        "settings": {"collect_words": True, "collect_per_player": 5, "rounds": 3},
    }
    s = c.post("/api/sessions", json=body, headers=A).json()
    sid = s["id"]
    assert s["status"] == "lobby" and s["collect"]["min_total"] == 4
    for h in (B, C):
        c.post(
            f"/api/sessions/{sid}/seat", json={"player_id": players[(B, C).index(h) + 1]}, headers=h
        )
    r = c.post(f"/api/sessions/{sid}/start", headers=A)
    assert r.status_code == 400 and "words" in r.json()["detail"]["message"]
    c.post(f"/api/sessions/{sid}/words", json={"text": "Grandma's soup\nThe lake house"}, headers=B)
    c.post(f"/api/sessions/{sid}/words", json={"text": "Our old Dacia\nNew Year 2020"}, headers=C)
    r = c.post(f"/api/sessions/{sid}/start", headers=A).json()
    assert r["status"] == "active"
    from app.db import SessionLocal
    from app.models import GameSession

    with SessionLocal() as db:
        state = db.get(GameSession, sid).progress
    word = state["r"]["word"]
    assert word["author"] in (players[1], players[2])
    assert word["author"] not in state["r"]["imposters"]
