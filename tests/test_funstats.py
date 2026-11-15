def play(c, players, game, scores, details=None, mode="solo", teams=None):
    body = {"game_id": game, "mode": mode, "player_ids": players}
    if teams:
        body["teams"] = teams
    s = c.post("/api/sessions", json=body).json()
    r = c.post(f"/api/sessions/{s['id']}/result", json={"scores": scores, "details": details or {}})
    assert r.status_code == 200, r.text
    return r.json()


def night_of_games(c, p):
    a, b, cc, d = p[:4]
    # Ana wins twice, Bogdan second twice, Cata never wins
    for _ in range(2):
        play(
            c,
            [a, b, cc],
            "heads-up",
            [
                {"player_id": a, "score": 9},
                {"player_id": b, "score": 5},
                {"player_id": cc, "score": 1},
            ],
            {"per_player": {str(a): 9, str(b): 5, str(cc): 1}},
        )
    # Bogdan beats Ana once
    play(
        c,
        [a, b, cc],
        "heads-up",
        [{"player_id": b, "score": 7}, {"player_id": a, "score": 2}, {"player_id": cc, "score": 0}],
        {"per_player": {str(b): 7, str(a): 2}},
    )
    # Tuned In, teams: Ana+Cata vs Bogdan+Dana; Dana hits a bullseye, Ana+Cata win
    play(
        c,
        [],
        "tuned-in",
        [{"team": 0, "score": 11}, {"team": 1, "score": 4}],
        {"turns": [{"player_id": d, "points": 4}, {"player_id": a, "points": 3}]},
        mode="teams",
        teams=[{"player_ids": [a, cc]}, {"player_ids": [b, d]}],
    )
    # Imposter: Dana escapes once, Cata gets caught
    play(
        c,
        [a, b, cc, d],
        "imposter",
        [
            {"player_id": d, "score": 2},
            {"player_id": a, "score": 1},
            {"player_id": b, "score": 1},
            {"player_id": cc, "score": 0},
        ],
        {"rounds": [{"imposters": [d], "accused": [a]}, {"imposters": [cc], "accused": [cc]}]},
    )


def test_night_awards(admin, players):
    c = admin
    night_of_games(c, players)
    night_id = c.get("/api/nights").json()[0]["id"]
    awards = {a["key"]: a for a in c.get(f"/api/nights/{night_id}").json()["awards"]}
    who = lambda k: [p["id"] for p in awards[k]["players"]]  # noqa: E731
    assert who("mvp") == [players[0]] and who("wins") == [players[0]]
    assert who("words") == [players[0]] and awards["words"]["value"] == 20  # 9 + 9 + 2
    assert who("bulls") == [players[3]] and who("escapes") == [players[3]]
    assert who("seconds") == [players[1]]  # 2 second places
    assert "sport" not in awards  # everyone won something (Cata with her team)
    assert "minds" not in awards  # no Popular Opinion played
    assert all(a["emoji"] and a["title"] for a in awards.values())


def test_profile_badges_and_head_to_head(admin, players):
    c = admin
    night_of_games(c, players)
    prof = c.get(f"/api/players/{players[0]}/profile").json()
    badges = {b["key"]: b for b in prof["badges"]}
    assert (
        badges["first_win"]["earned"]
        and badges["wordsmith"]["progress"] == 20
        and not badges["wordsmith"]["earned"]
    )
    assert badges["streak"]["progress"] == 2  # won 2 in a row, then lost
    rivals = {r["player"]["id"]: r for r in prof["h2h"]["rivals"]}
    bog = rivals[players[1]]
    # 2 Heads Up wins, 1 Heads Up loss, Tuned In win (team), Imposter tie (same score)
    assert (bog["games"], bog["wins"], bog["losses"], bog["ties"]) == (5, 3, 1, 1)
    assert prof["h2h"]["victim"]["player"]["id"] == players[2]  # Ana always beats Cata
    dana = c.get(f"/api/players/{players[3]}/profile").json()
    assert {b["key"]: b for b in dana["badges"]}["bullseye"]["earned"]
    # Ana & Cata were teammates once (needs 2 games for "best teammate")
    assert prof["h2h"]["best_teammate"] is None


def test_hall_of_fame_and_tv(admin, players):
    c = admin
    assert c.get("/api/tv").json()["night"] is None  # nothing played tonight yet
    c.put("/api/admin/settings", json={"min_sessions": 1})
    night_of_games(c, players)
    hof = c.get("/api/hall-of-fame").json()
    assert hof["months"][0]["champion"]["id"] == players[0]
    assert hof["most_titles"][0]["titles"] == 1
    # a game still running shows up on the TV board
    c.post("/api/sessions", json={"game_id": "heads-up", "player_ids": players[:2]})
    tv = c.get("/api/tv").json()
    assert tv["standings"][0]["player"]["id"] == players[0] and tv["games_played"] == 5
    assert len(tv["live"]) == 1 and tv["live"][0]["status"] == "active"
    assert tv["awards"] and tv["recent"][0]["game"]["name"] == "Imposter"
