"""Turn raw scores into placements and comparable 'overall points'.

placement formula: points = 100 * (beaten + (tied - 1) / 2) / (N - 1)
  -> winner 100, last 0, everyone else evenly in between; tied entries share.
winner formula:    100 for placement 1 (incl. ties), 0 for the rest.
Sessions with fewer than 2 ranked entries get no points (None).
"""

from __future__ import annotations

from collections.abc import Hashable

from ..models import GameSession

NEG_INF = float("-inf")


def rank(
    scores: dict[Hashable, float | None], higher_is_better: bool = True, formula: str = "placement"
) -> dict[Hashable, tuple[int, float | None]]:
    def value(s: float | None) -> float:
        if s is None:
            return NEG_INF  # no score -> treated as last
        return s if higher_is_better else -s

    values = {k: value(s) for k, s in scores.items()}
    n = len(values)
    out: dict[Hashable, tuple[int, float | None]] = {}
    for key, v in values.items():
        better = sum(1 for o in values.values() if o > v)
        worse = sum(1 for o in values.values() if o < v)
        tied = n - better - worse
        placement = better + 1
        if n < 2:
            points = None
        elif formula == "winner":
            points = 100.0 if placement == 1 else 0.0
        else:
            points = round(100 * (worse + (tied - 1) / 2) / (n - 1), 1)
        out[key] = (placement, points)
    return out


def recompute_session(session: GameSession, higher_is_better: bool, formula: str) -> None:
    """(Re)compute placements/points from the stored scores of a session."""
    if session.mode == "teams":
        team_scores = {t.idx: t.score for t in session.teams}
        ranked = rank(team_scores, higher_is_better, formula)
        for team in session.teams:
            team.placement, team.points = ranked[team.idx]
        by_idx = {t.idx: t for t in session.teams}
        for p in session.participants:
            team = by_idx.get(p.team_idx)
            p.score = team.score if team else None
            p.placement = team.placement if team else None
            p.points = team.points if team else None
    else:
        ranked = rank(
            {p.player_id: p.score for p in session.participants}, higher_is_better, formula
        )
        for p in session.participants:
            p.placement, p.points = ranked[p.player_id]
