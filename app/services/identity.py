"""One phone per name.

- A free name (no phone holds it) is taken right away.
- If another phone holds it and was used within `name_hold_minutes` (default 30), that phone must
  allow the move. A phone unused for longer gives the name up without asking.
- After 3 denials the asking phone waits 5 minutes before it can ask for that name again.
- When a name moves, its seats in running multi-phone games move along to the new phone.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import (
    LIVE_STATUSES,
    Device,
    GameSession,
    IdentityRequest,
    Player,
    SessionParticipant,
    utcnow,
)
from .runtime import get_runtime

MAX_DENIALS = 3
COOLDOWN = timedelta(minutes=5)


class IdentityError(ValueError):
    def __init__(self, message: str, status: int = 400, info: dict | None = None):
        super().__init__(message)
        self.status = status
        self.info = info or {}


def hold_window(db: Session) -> timedelta:
    return timedelta(minutes=float(get_runtime(db)["name_hold_minutes"]))


def holders(db: Session, player_id: int, exclude: str | None = None) -> list[Device]:
    q = select(Device).where(Device.player_id == player_id)
    if exclude:
        q = q.where(Device.id != exclude)
    return list(db.scalars(q))


def active_holder(db: Session, player_id: int, exclude: str | None = None) -> Device | None:
    """The other phone that still 'owns' this name (used recently), if any."""
    cutoff = utcnow() - hold_window(db)
    live = [d for d in holders(db, player_id, exclude) if d.last_seen >= cutoff]
    return max(live, key=lambda d: d.last_seen) if live else None


def names_in_use(db: Session, exclude: str | None = None) -> set[int]:
    cutoff = utcnow() - hold_window(db)
    q = select(Device.player_id).where(Device.player_id.is_not(None), Device.last_seen >= cutoff)
    if exclude:
        q = q.where(Device.id != exclude)
    return set(db.scalars(q))


def move_name(db: Session, player_id: int | None, device: Device) -> None:
    """Give `player_id` to `device` (None = clear). Other phones lose it; seats move along."""
    if player_id is not None:
        for other in holders(db, player_id, exclude=device.id):
            for seat in db.scalars(
                select(SessionParticipant)
                .join(GameSession, GameSession.id == SessionParticipant.session_id)
                .where(
                    SessionParticipant.player_id == player_id,
                    SessionParticipant.device_id == other.id,
                    GameSession.status.in_(LIVE_STATUSES),
                )
            ):
                seat.device_id = device.id
                if (
                    s := db.get(GameSession, seat.session_id)
                ) and s.controller_device_id == other.id:
                    s.controller_device_id = device.id  # the host was Ana's old phone
            other.player_id = None
    device.player_id = player_id
    db.flush()


def _denial_state(db: Session, requester: str, player_id: int) -> tuple[int, int]:
    """(seconds of cooldown left, denials counted since the last cooldown)."""
    denials = db.scalars(
        select(IdentityRequest.decided_at)
        .where(
            IdentityRequest.requester_device_id == requester,
            IdentityRequest.player_id == player_id,
            IdentityRequest.status == "denied",
            IdentityRequest.decided_at >= utcnow() - timedelta(hours=1),
        )
        .order_by(IdentityRequest.decided_at)
    ).all()
    count, until = 0, None
    for ts in denials:
        if until and ts < until:
            continue
        count += 1
        if count == MAX_DENIALS:  # 3 denials -> 5 minutes cooldown, then 3 new tries
            until, count = ts + COOLDOWN, 0
    left = max(0, int((until - utcnow()).total_seconds())) if until else 0
    return left, count


def _cooldown_left(db: Session, requester: str, player_id: int) -> int:
    return _denial_state(db, requester, player_id)[0]


def _seen_ago(ts: datetime) -> int:
    return int((utcnow() - ts).total_seconds())


def request_name(db: Session, device_id: str | None, player_id: int | None) -> dict[str, Any]:
    if not device_id:
        raise IdentityError("Missing device id")
    from .live import touch_device

    me = touch_device(db, device_id)
    if player_id is None:
        move_name(db, None, me)
        return {"status": "granted"}
    p = db.get(Player, player_id)
    if p is None or not p.active:
        raise IdentityError("Unknown player")
    if me.player_id == player_id:
        return {"status": "granted"}
    owner = active_holder(db, player_id, exclude=device_id)
    if owner is None:
        move_name(db, player_id, me)
        return {"status": "granted"}
    if left := _cooldown_left(db, device_id, player_id):
        raise IdentityError(
            f"{p.name}'s phone said no 3 times: try again in {max(1, round(left / 60))} min",
            429,
            {"cooldown_seconds": left},
        )
    req = db.scalars(
        select(IdentityRequest).where(
            IdentityRequest.requester_device_id == device_id,
            IdentityRequest.player_id == player_id,
            IdentityRequest.status == "pending",
        )
    ).first()
    if req is None:
        req = IdentityRequest(
            player_id=player_id, requester_device_id=device_id, owner_device_id=owner.id
        )
        db.add(req)
        db.flush()
    return _status(db, req)


def _status(db: Session, req: IdentityRequest) -> dict[str, Any]:
    p = db.get(Player, req.player_id)
    who = {"id": p.id, "name": p.name, "emoji": p.emoji} if p else None
    if req.status == "pending":
        owner = db.get(Device, req.owner_device_id)
        # the owner stopped using the name meanwhile -> it's free
        if (
            owner is None
            or owner.player_id != req.player_id
            or owner.last_seen < utcnow() - hold_window(db)
        ):
            req.status, req.decided_at = "approved", utcnow()
            move_name(db, req.player_id, db.get(Device, req.requester_device_id))
        else:
            return {
                "status": "pending",
                "request_id": req.id,
                "player": who,
                "owner_seen_seconds_ago": _seen_ago(owner.last_seen),
                "hold_minutes": round(hold_window(db).total_seconds() / 60),
            }
    if req.status == "approved":
        return {"status": "granted", "player": who}
    if req.status == "denied":
        left, used = _denial_state(db, req.requester_device_id, req.player_id)
        return {
            "status": "denied",
            "player": who,
            "cooldown_seconds": left,
            "tries_left": 0 if left else MAX_DENIALS - used,
        }
    return {"status": req.status, "player": who}


def request_status(db: Session, request_id: int, device_id: str | None) -> dict[str, Any]:
    req = db.get(IdentityRequest, request_id)
    if req is None or req.requester_device_id != device_id:
        raise IdentityError("Request not found", 404)
    from .live import touch_device

    touch_device(db, device_id)
    out = _status(db, req)
    db.flush()
    return out


def cancel(db: Session, request_id: int, device_id: str | None) -> None:
    req = db.get(IdentityRequest, request_id)
    if req and req.requester_device_id == device_id and req.status == "pending":
        req.status, req.decided_at = "cancelled", utcnow()
        db.flush()


def decide(db: Session, request_id: int, device_id: str | None, approve: bool) -> None:
    req = db.get(IdentityRequest, request_id)
    if req is None or req.owner_device_id != device_id:
        raise IdentityError("Request not found", 404)
    if req.status != "pending":
        return
    req.status = "approved" if approve else "denied"
    req.decided_at = utcnow()
    if approve:
        requester = db.get(Device, req.requester_device_id)
        if requester:
            move_name(db, req.player_id, requester)
    db.flush()


def pending_for(db: Session, device_id: str | None) -> list[dict[str, Any]]:
    """Name requests this phone has to answer (shown together with takeover requests)."""
    if not device_id:
        return []
    out = []
    for r in db.scalars(
        select(IdentityRequest).where(
            IdentityRequest.owner_device_id == device_id, IdentityRequest.status == "pending"
        )
    ):
        requester = db.get(Device, r.requester_device_id)
        if requester is None or requester.last_seen < utcnow() - timedelta(minutes=2):
            continue  # the asking phone went away
        p = db.get(Player, r.player_id)
        out.append(
            {
                "id": r.id,
                "reason": "name",
                "player": {"id": p.id, "name": p.name, "emoji": p.emoji} if p else None,
                "decide_url": f"/api/identity-requests/{r.id}/decide",
            }
        )
    return out


def release(db: Session, player_id: int) -> int:
    """Admin: free a name from every phone."""
    n = 0
    for d in holders(db, player_id):
        d.player_id = None
        n += 1
    db.flush()
    return n
