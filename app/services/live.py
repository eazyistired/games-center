"""Live sessions: devices, the controlling phone (one-phone play), takeovers, idle sessions.

- A device is "active" when it sent a heartbeat in the last ACTIVE_SECONDS.
- In one-phone play the controller device drives the session; only it may save/finish.
- Taking over needs approval from (a) the controller if it is active and (b) any other active
  device that is the same player as the requester (someone else might be using "your" name).
  A device that goes quiet (locked phone) counts as having approved.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import LIVE_STATUSES, Device, GameSession, TakeoverRequest, utcnow
from .registry import get_manifest

log = logging.getLogger(__name__)

ACTIVE_SECONDS = 30  # "quiet after" - set from the runtime settings (Admin -> Settings)


def configure(quiet_seconds: int) -> None:
    global ACTIVE_SECONDS
    ACTIVE_SECONDS = int(quiet_seconds)


def heartbeat_ms() -> int:
    """How often phones check in: well within the quiet window."""
    return int(max(2, min(5, ACTIVE_SECONDS / 4)) * 1000)


_DEVICE_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


class LiveError(ValueError):
    def __init__(self, message: str, status: int = 409, info: dict | None = None):
        super().__init__(message)
        self.status = status
        self.info = info or {}


def valid_device_id(value: str | None) -> str | None:
    return value if value and _DEVICE_RE.match(value) else None


def is_fresh(ts: datetime | None, now: datetime | None = None) -> bool:
    return ts is not None and (now or utcnow()) - ts < timedelta(seconds=ACTIVE_SECONDS)


def touch_device(db: Session, device_id: str | None, label: str | None = None) -> Device | None:
    if not device_id:
        return None
    dev = db.get(Device, device_id)
    if dev is None:
        dev = Device(id=device_id, label=(label or "")[:120])
        db.add(dev)
    elif label:
        dev.label = label[:120]
    dev.last_seen = utcnow()
    db.flush()
    return dev


def player_brief(dev: Device | None) -> dict[str, Any] | None:
    if dev is None or dev.player is None:
        return None
    return {"id": dev.player.id, "name": dev.player.name, "emoji": dev.player.emoji}


# ---------------------------------------------------------------- session status


def controller_active(s: GameSession) -> bool:
    return bool(s.controller_device_id) and is_fresh(s.controller_seen_at)


def live_status(s: GameSession) -> str:
    if s.status in ("lobby", "collecting"):
        return s.status
    if s.status != "active":
        return s.status
    return "playing" if controller_active(s) else "paused"


def live_info(db: Session, s: GameSession, device_id: str | None) -> dict[str, Any]:
    ctrl = db.get(Device, s.controller_device_id) if s.controller_device_id else None
    return {
        "live_status": live_status(s),
        "device_mode": s.device_mode,
        "version": s.state_version,
        "controller": {
            "player": player_brief(ctrl),
            "active": controller_active(s),
            "seen_at": s.controller_seen_at.isoformat() + "Z" if s.controller_seen_at else None,
        }
        if s.controller_device_id
        else None,
        "controlled_by_me": bool(device_id) and s.controller_device_id == device_id,
        "heartbeat_ms": heartbeat_ms(),
        "quiet_seconds": ACTIVE_SECONDS,
    }


# ---------------------------------------------------------------- control


def require_control(s: GameSession, device_id: str | None) -> None:
    """Saving/finishing is only allowed for the controller (or anyone if nobody controls it)."""
    if s.controller_device_id and s.controller_device_id != device_id:
        raise LiveError("This game continued on another phone", info={"lost": True})


def claim_control(db: Session, s: GameSession, device_id: str | None) -> None:
    """Free (no controller / controller quiet) or already mine -> mine. Otherwise conflict."""
    if s.status != "active":
        raise LiveError(f"Session is {s.status}", status=400)
    if not device_id:
        raise LiveError("Missing device id", status=400)
    mine = s.controller_device_id == device_id
    if not mine and s.controller_device_id and controller_active(s):
        raise LiveError("This game is running on another phone", info={"needs_takeover": True})
    approvers = [] if mine else _identity_approvers(db, s, device_id)
    if approvers:
        raise LiveError("Your name is active on another phone", info={"needs_takeover": True})
    _grant(db, s, device_id)


def _grant(db: Session, s: GameSession, device_id: str) -> None:
    s.controller_device_id = device_id
    s.controller_seen_at = utcnow()
    for r in db.scalars(
        select(TakeoverRequest).where(
            TakeoverRequest.session_id == s.id, TakeoverRequest.status == "pending"
        )
    ):
        r.status = "cancelled"
        r.decided_at = utcnow()
    db.flush()


def heartbeat(db: Session, s: GameSession, device_id: str | None) -> dict[str, Any]:
    in_control = bool(device_id) and s.controller_device_id == device_id and s.status == "active"
    if in_control:
        s.controller_seen_at = utcnow()
    db.flush()
    return {
        "in_control": in_control,
        "status": s.status,
        "requests": pending_for(db, device_id),
        **live_info(db, s, device_id),
    }


def _identity_approvers(db: Session, s: GameSession, device_id: str) -> list[str]:
    """Other active devices that are the same player as the requester."""
    me = db.get(Device, device_id)
    if me is None or me.player_id is None:
        return []
    others = db.scalars(
        select(Device).where(Device.player_id == me.player_id, Device.id != device_id)
    )
    return [d.id for d in others if is_fresh(d.last_seen) and d.id != s.controller_device_id]


def request_takeover(db: Session, s: GameSession, device_id: str | None) -> dict[str, Any]:
    if s.status != "active":
        raise LiveError(f"Session is {s.status}", status=400)
    if not device_id:
        raise LiveError("Missing device id", status=400)
    if s.controller_device_id == device_id:
        _grant(db, s, device_id)
        return {"status": "granted"}
    needed: list[tuple[str, str]] = []
    if s.controller_device_id and controller_active(s):
        needed.append((s.controller_device_id, "controller"))
    needed += [(d, "identity") for d in _identity_approvers(db, s, device_id)]
    if not needed:
        _grant(db, s, device_id)
        return {"status": "granted"}
    # a new attempt: earlier answers (e.g. a "deny" a minute ago) no longer count
    for old in db.scalars(
        select(TakeoverRequest).where(
            TakeoverRequest.session_id == s.id,
            TakeoverRequest.requester_device_id == device_id,
            TakeoverRequest.status.in_(["approved", "denied"]),
        )
    ):
        old.status = "closed"
    existing = {
        r.approver_device_id: r
        for r in db.scalars(
            select(TakeoverRequest).where(
                TakeoverRequest.session_id == s.id,
                TakeoverRequest.requester_device_id == device_id,
                TakeoverRequest.status == "pending",
            )
        )
    }
    for approver, reason in needed:
        if approver not in existing:
            db.add(
                TakeoverRequest(
                    session_id=s.id,
                    requester_device_id=device_id,
                    approver_device_id=approver,
                    reason=reason,
                )
            )
    db.flush()
    return takeover_status(db, s, device_id)


def takeover_status(db: Session, s: GameSession, device_id: str | None) -> dict[str, Any]:
    """Evaluate the requester's pending requests; grant when everyone allowed (or went quiet)."""
    if s.controller_device_id == device_id and s.status == "active":
        return {"status": "granted"}
    reqs = db.scalars(
        select(TakeoverRequest).where(
            TakeoverRequest.session_id == s.id,
            TakeoverRequest.requester_device_id == device_id,
            TakeoverRequest.status.in_(["pending", "approved", "denied"]),
            TakeoverRequest.created_at >= utcnow() - timedelta(minutes=10),
        )
    ).all()
    if not reqs:
        return {"status": "none"}
    waiting = []
    for r in reqs:
        if r.status == "pending":
            approver = db.get(Device, r.approver_device_id)
            if approver is None or not is_fresh(approver.last_seen):
                r.status, r.decided_at = "approved", utcnow()  # quiet phone = approved
            else:
                waiting.append({"reason": r.reason, "player": player_brief(approver)})
    if any(r.status == "denied" for r in reqs):
        for r in reqs:
            if r.status == "pending":
                r.status = "cancelled"
        db.flush()
        return {"status": "denied"}
    if waiting:
        db.flush()
        return {"status": "pending", "waiting_for": waiting}
    _grant(db, s, device_id)  # type: ignore[arg-type]
    return {"status": "granted"}


def cancel_takeover(db: Session, s: GameSession, device_id: str | None) -> None:
    for r in db.scalars(
        select(TakeoverRequest).where(
            TakeoverRequest.session_id == s.id,
            TakeoverRequest.requester_device_id == device_id,
            TakeoverRequest.status == "pending",
        )
    ):
        r.status, r.decided_at = "cancelled", utcnow()
    db.flush()


def pending_for(db: Session, device_id: str | None) -> list[dict[str, Any]]:
    """Takeover requests this device has to answer."""
    if not device_id:
        return []
    out = []
    for r in db.scalars(
        select(TakeoverRequest).where(
            TakeoverRequest.approver_device_id == device_id,
            TakeoverRequest.status == "pending",
        )
    ):
        s = db.get(GameSession, r.session_id)
        requester = db.get(Device, r.requester_device_id)
        if s is None or s.status != "active" or requester is None:
            r.status = "cancelled"
            continue
        if requester.last_seen < utcnow() - timedelta(seconds=2 * ACTIVE_SECONDS):
            continue  # the requesting phone went away: don't bother this one
        m = get_manifest(s.game_id) or {}
        out.append(
            {
                "id": r.id,
                "reason": r.reason,
                "session_id": s.id,
                "game": {"name": m.get("name", s.game_id), "emoji": m.get("emoji", "🎲")},
                "requester": player_brief(requester),
            }
        )
    db.flush()
    return out


def decide(db: Session, request_id: int, device_id: str | None, approve: bool) -> None:
    r = db.get(TakeoverRequest, request_id)
    if r is None or r.approver_device_id != device_id:
        raise LiveError("Request not found", status=404)
    if r.status == "pending":
        r.status = "approved" if approve else "denied"
        r.decided_at = utcnow()
    db.flush()


# ---------------------------------------------------------------- idle sessions


def close_idle_sessions(db: Session, hours: float = 2) -> dict[str, int]:
    """Active sessions nobody controlled for `hours`: auto-finish with the scores so far (if the
    game reported any), otherwise abandon."""
    from .sessions import SessionError, submit_result  # local import: avoid a cycle

    cutoff = utcnow() - timedelta(hours=hours)
    finished = abandoned = 0
    for s in db.scalars(select(GameSession).where(GameSession.status.in_(LIVE_STATUSES))).all():
        last = s.controller_seen_at or s.started_at
        if last >= cutoff:
            continue
        partial = s.partial_result or {}
        if s.status == "active" and partial.get("scores"):
            details = dict(partial.get("details") or {})
            details["summary"] = (details.get("summary") or "Scores so far") + " · auto-finished"
            details["auto_finished"] = True
            try:
                submit_result(db, s, partial["scores"], details, None)
                finished += 1
                continue
            except SessionError as exc:
                log.warning("auto-finish of session %s failed: %s", s.id, exc)
        s.status = "abandoned"
        abandoned += 1
    db.flush()
    return {"finished": finished, "abandoned": abandoned}
