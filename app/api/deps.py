from typing import Annotated

from fastapi import Depends, Header, HTTPException
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import GameSession

DB = Annotated[Session, Depends(get_db)]


def get_session_or_404(db: Session, session_id: int) -> GameSession:
    s = db.get(GameSession, session_id)
    if s is None:
        raise HTTPException(404, "Session not found")
    return s


def bad_request(message: str) -> HTTPException:
    return HTTPException(400, message)


def device_header(x_device_id: Annotated[str | None, Header()] = None) -> str | None:
    from ..services.live import valid_device_id

    return valid_device_id(x_device_id)


DeviceId = Annotated[str | None, Depends(device_header)]
