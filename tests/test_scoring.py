from app.services.scoring import rank


def test_placement_spread():
    r = rank({"a": 10, "b": 5, "c": 1})
    assert r == {"a": (1, 100.0), "b": (2, 50.0), "c": (3, 0.0)}


def test_ties_share_points():
    r = rank({"a": 10, "b": 10, "c": 1})
    assert r["a"] == (1, 75.0) and r["b"] == (1, 75.0) and r["c"] == (3, 0.0)


def test_lower_is_better():
    r = rank({"a": 3, "b": 9}, higher_is_better=False)
    assert r["a"] == (1, 100.0) and r["b"] == (2, 0.0)


def test_missing_score_is_last():
    r = rank({"a": None, "b": 0})
    assert r["b"][0] == 1 and r["a"][0] == 2


def test_single_entry_has_no_points():
    assert rank({"a": 5}) == {"a": (1, None)}


def test_winner_formula():
    r = rank({"a": 5, "b": 4, "c": 1}, formula="winner")
    assert [r[k][1] for k in "abc"] == [100.0, 0.0, 0.0]
