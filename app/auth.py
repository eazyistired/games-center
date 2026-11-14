"""Admin authentication: one password (ADMIN_PASSWORD) -> signed cookie."""

from __future__ import annotations

import hashlib
import hmac
import time

from fastapi import HTTPException, Request, Response
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from .config import get_settings

COOKIE = "gc_admin"
MAX_AGE = 30 * 24 * 3600
_failures: dict[str, list[float]] = {}


def _serializer() -> URLSafeTimedSerializer:
    settings = get_settings()
    # Changing ADMIN_PASSWORD invalidates every existing admin cookie.
    pw_hash = hashlib.sha256(settings.admin_password.encode()).hexdigest()[:16]
    return URLSafeTimedSerializer(settings.secret_key, salt=f"admin:{pw_hash}")


def check_password(password: str, client: str) -> bool:
    settings = get_settings()
    now = time.time()
    recent = [t for t in _failures.get(client, []) if now - t < 300]
    if len(recent) >= 10:
        raise HTTPException(429, "Too many attempts, try again in a few minutes")
    ok = bool(settings.admin_password) and hmac.compare_digest(
        password.encode(), settings.admin_password.encode()
    )
    if not ok:
        recent.append(now)
        _failures[client] = recent
    else:
        _failures.pop(client, None)
    return ok


def set_admin_cookie(response: Response) -> None:
    response.set_cookie(
        COOKIE,
        _serializer().dumps({"admin": True}),
        max_age=MAX_AGE,
        httponly=True,
        samesite="strict",
        secure=get_settings().secure_cookies,
    )


def clear_admin_cookie(response: Response) -> None:
    response.delete_cookie(COOKIE)


def is_admin(request: Request) -> bool:
    token = request.cookies.get(COOKIE)
    if not token or not get_settings().admin_password:
        return False
    try:
        data = _serializer().loads(token, max_age=MAX_AGE)
    except (BadSignature, SignatureExpired):
        return False
    return bool(data.get("admin"))


def require_admin(request: Request) -> None:
    if not is_admin(request):
        raise HTTPException(401, "Admin login required")
