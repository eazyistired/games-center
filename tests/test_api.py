def start(client, player_ids, mode="solo", teams=None, settings=None):
    body = {
        "game_id": "heads-up",
        "mode": mode,
        "player_ids": player_ids,
        "settings": settings or {},
    }
    if teams:
        body["teams"] = teams
    r = client.post("/api/sessions", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def test_health_and_games(client):
    assert client.get("/api/health").json()["status"] == "ok"
    games = client.get("/api/games").json()
    assert [g["id"] for g in games] == ["heads-up", "imposter"]
    full = client.get("/api/games/heads-up").json()
    assert len(full["decks"]) == 9
    assert full["defaults"]["round_seconds"] == 60


def test_static_pages(client):
    assert client.get("/").status_code == 200
    assert client.get("/admin").status_code == 200  # redirect followed
    assert client.get("/games/heads-up/manifest.json").status_code == 200


def test_admin_requires_login(client):
    assert client.get("/api/admin/players").status_code == 401
    assert client.post("/api/admin/login", json={"password": "nope"}).status_code == 401


def test_solo_session_flow(admin, players):
    c = admin
    s = start(c, players[:3], settings={"round_seconds": 90, "bogus": 1})
    assert s["settings"]["round_seconds"] == 90 and "bogus" not in s["settings"]
    words = c.get(f"/api/sessions/{s['id']}/words").json()
    assert len(words) > 500
    assert (
        c.put(f"/api/sessions/{s['id']}/progress", json={"state": {"turn": 1}}).status_code == 200
    )
    assert c.get("/api/sessions/active").json()[0]["id"] == s["id"]
    r = c.post(
        f"/api/sessions/{s['id']}/result",
        json={
            "scores": [
                {"player_id": players[0], "score": 7},
                {"player_id": players[1], "score": 3},
                {"player_id": players[2], "score": 3},
            ],
            "word_plays": [
                {"word_id": words[0]["id"], "result": "correct"},
                {"word_id": words[1]["id"], "result": "pass"},
            ],
        },
    )
    assert r.status_code == 200, r.text
    parts = {p["player_id"]: p for p in r.json()["participants"]}
    assert parts[players[0]]["points"] == 100 and parts[players[1]]["points"] == 25
    # second submit is rejected
    assert c.post(f"/api/sessions/{s['id']}/result", json={"scores": []}).status_code == 400
    # words used tonight go to the end of the next session's list
    s2 = start(c, players[:3])
    w2 = c.get(f"/api/sessions/{s2['id']}/words").json()
    assert w2[-1]["id"] in {words[0]["id"], words[1]["id"]}

    board = c.get("/api/leaderboards?period=tonight").json()["entries"]
    assert board[0]["player"]["id"] == players[0] and board[0]["wins"] == 1
    lineups = c.get("/api/games/heads-up/lineups").json()
    assert len(lineups) == 1 and sorted(lineups[0]["player_ids"]) == sorted(players[:3])
    summary = c.get(f"/api/sessions/{s['id']}/summary").json()
    assert summary["night_standings"][0]["player"]["id"] == players[0]
    prof = c.get(f"/api/players/{players[0]}/profile").json()
    assert prof["overall"]["wins"] == 1 and prof["best_win_streak"] == 1


def test_team_session(admin, players):
    c = admin
    s = start(c, [], mode="teams", teams=[{"player_ids": players[:3]}, {"player_ids": players[3:]}])
    assert [t["name"] for t in s["teams"]] == ["Red", "Blue"]
    r = c.post(
        f"/api/sessions/{s['id']}/result",
        json={"scores": [{"team": 0, "score": 4}, {"team": 1, "score": 9}]},
    )
    parts = {p["player_id"]: p for p in r.json()["participants"]}
    assert parts[players[4]]["placement"] == 1 and parts[players[4]]["points"] == 100
    assert parts[players[0]]["points"] == 0
    lineups = c.get("/api/games/heads-up/lineups").json()
    assert lineups[0]["teams"][0]["player_ids"] == sorted(players[:3])


def test_validation(admin, players):
    c = admin
    r = c.post("/api/sessions", json={"game_id": "heads-up", "player_ids": players[:1]})
    assert r.status_code == 400
    r = c.post(
        "/api/sessions",
        json={"game_id": "heads-up", "mode": "teams", "teams": [{"player_ids": players[:2]}]},
    )
    assert r.status_code == 400


def test_admin_players(admin):
    c = admin
    r = c.post("/api/admin/players/bulk", json={"text": "🐻 Ana\nBogdan 🦁\nCata\nana"})
    assert r.json()["added"] == ["Ana", "Bogdan", "Cata"] and r.json()["skipped"] == ["ana"]
    ps = {p["name"]: p for p in c.get("/api/admin/players").json()}
    assert ps["Ana"]["emoji"] == "🐻" and ps["Bogdan"]["emoji"] == "🦁"
    a, b = ps["Ana"]["id"], ps["Bogdan"]["id"]
    assert c.put(f"/api/admin/players/{b}", json={"name": "ana"}).status_code == 400
    c.put(f"/api/admin/players/{b}", json={"active": False})
    assert b not in [p["id"] for p in c.get("/api/players").json()]
    c.put(f"/api/admin/players/{b}", json={"active": True})
    s = start(c, [a, b, ps["Cata"]["id"]])
    c.post(f"/api/sessions/{s['id']}/result", json={"scores": [{"player_id": b, "score": 5}]})
    assert c.delete(f"/api/admin/players/{b}").status_code == 400
    r = c.post(f"/api/admin/players/{b}/merge", json={"into_id": a})
    assert r.status_code == 200
    sess = c.get(f"/api/sessions/{s['id']}").json()
    assert {p["player_id"] for p in sess["participants"]} == {a, ps["Cata"]["id"]}
    assert len(c.get("/api/admin/audit").json()["items"]) >= 4


def test_admin_session_edit_void(admin, players):
    c = admin
    s = start(c, players[:3])
    c.post(
        f"/api/sessions/{s['id']}/result",
        json={
            "scores": [
                {"player_id": players[0], "score": 1},
                {"player_id": players[1], "score": 2},
                {"player_id": players[2], "score": 3},
            ]
        },
    )
    r = c.put(
        f"/api/admin/sessions/{s['id']}",
        json={
            "participants": [
                {"player_id": players[0], "score": 10},
                {"player_id": players[1], "score": 2},
                {"player_id": players[3], "score": 0},
            ]
        },
    )
    assert r.status_code == 200, r.text
    parts = {p["player_id"]: p for p in r.json()["participants"]}
    assert set(parts) == {players[0], players[1], players[3]}
    assert parts[players[0]]["placement"] == 1
    c.post(f"/api/admin/sessions/{s['id']}/void")
    assert c.get("/api/leaderboards").json()["entries"] == []
    c.post(f"/api/admin/sessions/{s['id']}/restore")
    assert len(c.get("/api/leaderboards").json()["entries"]) == 3
    # change formula -> recomputed
    c.put("/api/admin/settings", json={"scoring_formula": "winner"})
    sess = c.get(f"/api/sessions/{s['id']}").json()
    assert sorted(p["points"] for p in sess["participants"]) == [0, 0, 100]
    assert c.put("/api/admin/settings", json={"timezone": "Mars/Base"}).status_code == 400


def test_decks_admin(admin):
    c = admin
    r = c.post(
        "/api/admin/decks",
        json={
            "game_id": "heads-up",
            "name": "Inside jokes",
            "words": "The red car\nUncle's BBQ\nThe red car",
        },
    )
    d = r.json()
    assert d["word_count"] == 2 and not d["builtin"]
    r = c.post(f"/api/admin/decks/{d['id']}/words", json={"text": "a, b, c"})
    assert r.json()["added"] == 3
    builtin = [x for x in c.get("/api/admin/decks").json() if x["builtin"]][0]
    assert c.delete(f"/api/admin/decks/{builtin['id']}").status_code == 400
    c.put(f"/api/admin/decks/{builtin['id']}", json={"enabled": False})
    decks = c.get("/api/games/heads-up").json()["decks"]
    assert builtin["id"] not in [x["id"] for x in decks]


def test_nights_merge(admin, players):
    c = admin
    s = start(c, players[:2])
    c.post(f"/api/sessions/{s['id']}/result", json={"scores": []})
    other = c.post("/api/admin/nights", json={"date": "2026-01-01", "label": "NYE"}).json()
    night_id = s["night"]["id"]
    assert c.delete(f"/api/admin/nights/{night_id}").status_code == 400
    assert (
        c.post(f"/api/admin/nights/{night_id}/merge", json={"into_id": other["id"]}).json()["moved"]
        == 1
    )
    nights = c.get("/api/nights").json()
    assert nights[0]["label"] == "NYE" and nights[0]["session_count"] == 1


def test_backup_export_import(admin, players):
    c = admin
    assert c.post("/api/admin/backups").status_code == 200
    assert len(c.get("/api/admin/backups").json()) == 1
    name = c.get("/api/admin/backups").json()[0]["name"]
    assert c.get(f"/api/admin/backups/{name}").status_code == 200
    assert c.get("/api/admin/backups/..%2Fgames.db").status_code == 404
    export = c.get("/api/admin/export").json()
    assert len(export["tables"]["players"]) == 6
    c.post("/api/admin/players", json={"name": "Zed"})
    r = c.post("/api/admin/import", files={"file": ("x.json", __import__("json").dumps(export))})
    assert r.status_code == 200, r.text
    assert len(c.get("/api/players").json()) == 6
    assert c.get("/api/admin/dashboard").json()["totals"]["players"] == 6


def test_imposter_uses_heads_up_decks(admin, players):
    c = admin
    game = c.get("/api/games/imposter").json()
    assert len(game["decks"]) == 9 and game["defaults"]["rounds"] == 5
    s = c.post(
        "/api/sessions",
        json={"game_id": "imposter", "player_ids": players[:4], "settings": {"decks": []}},
    ).json()
    words = c.get(f"/api/sessions/{s['id']}/words").json()
    assert len(words) > 900
    # custom deck created for heads-up is visible to imposter too
    c.post("/api/admin/decks", json={"game_id": "heads-up", "name": "Jokes", "words": "a\nb"})
    assert any(d["name"] == "Jokes" for d in c.get("/api/games/imposter").json()["decks"])
    r = c.post("/api/admin/decks", json={"game_id": "imposter", "name": "Xyz", "words": "q"})
    assert r.json()["game_id"] == "heads-up"
    assert any(d["name"] == "Xyz" for d in c.get("/api/games/imposter").json()["decks"])
