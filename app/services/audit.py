from typing import Any

from sqlalchemy.orm import Session

from ..models import AuditLog


def audit(
    db: Session, action: str, entity: str, entity_id: Any = None, detail: dict | None = None
) -> None:
    db.add(
        AuditLog(
            action=action,
            entity=entity,
            entity_id=None if entity_id is None else str(entity_id),
            detail=detail,
        )
    )
