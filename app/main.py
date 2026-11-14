"""FastAPI application: API + static shell, admin and games."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select

from . import __version__
from .api import admin, public
from .config import Settings, get_settings
from .db import SessionLocal, init_engine
from .engines import load_engines
from .migrate import run_migrations
from .realtime import LIVE_ROOM, hub
from .services import backup as bk
from .services.decks import sync_builtin_decks
from .services.live import valid_device_id
from .services.registry import load_manifests, sync_games

log = logging.getLogger("games_center")


def startup(settings: Settings) -> None:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    init_engine(settings.db_path)
    run_migrations(settings.db_path)
    load_manifests(settings.games_dir)
    load_engines()
    with SessionLocal() as db:
        sync_games(db)
        sync_builtin_decks(db, settings.games_dir)
        db.commit()
        from .services.runtime import apply_runtime, get_runtime

        apply_runtime(get_runtime(db))


def build_payload(session_id: int, device_id: str | None) -> dict | None:
    from .models import GameSession
    from .services.multi import session_payload

    with SessionLocal() as db:
        s = db.get(GameSession, session_id)
        if s is None:
            return None
        return {
            "type": "session",
            "session": session_payload(db, s, device_id, hub.online_devices(s.id)),
        }


def touch(device_id: str | None) -> None:
    """Any websocket message = this phone is active."""
    if not device_id:
        return
    from .services.live import touch_device

    with SessionLocal() as db:
        touch_device(db, device_id)
        db.commit()


def close_idle(settings: Settings) -> None:
    from .services.live import close_idle_sessions

    with SessionLocal() as db:
        from .services.runtime import get_runtime

        result = close_idle_sessions(db, get_runtime(db)["idle_hours"])
        db.commit()
    if any(result.values()):
        log.info("idle sessions closed: %s", result)


def watch_hosts() -> None:
    """Lobbies whose host phone left get the next joined player as host."""
    from .models import GameSession
    from .services.multi import reassign_if_host_gone

    moved = []
    with SessionLocal() as db:
        lobbies = db.scalars(
            select(GameSession).where(
                GameSession.status == "lobby", GameSession.device_mode == "multi"
            )
        ).all()
        for s in lobbies:
            if reassign_if_host_gone(db, s, hub.online_devices(s.id)):
                moved.append(s.id)
        db.commit()
    for sid in moved:
        hub.notify(sid)


async def host_watch_loop() -> None:
    while True:
        await asyncio.sleep(10)
        try:
            await asyncio.to_thread(watch_hosts)
        except Exception:  # pragma: no cover
            log.exception("host watch failed")


async def housekeeping_loop(settings: Settings) -> None:
    """Every 10 minutes: auto-finish/abandon sessions nobody controlled for SESSION_IDLE_HOURS."""
    while True:
        try:
            await asyncio.to_thread(close_idle, settings)
        except Exception:  # pragma: no cover
            log.exception("closing idle sessions failed")
        await asyncio.sleep(600)


async def backup_loop(settings: Settings) -> None:
    """Make a backup when the newest one is older than 24h (checked hourly)."""
    await asyncio.sleep(60)
    while True:
        try:
            age = bk.latest_backup_age_hours(settings)
            if age is None or age >= 24:
                await asyncio.to_thread(bk.make_backup, settings, "auto")
        except Exception:  # pragma: no cover - never kill the loop
            log.exception("automatic backup failed")
        await asyncio.sleep(3600)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        startup(settings)
        hub.loop = asyncio.get_running_loop()
        hub.build_session_payload = build_payload
        tasks = [
            asyncio.create_task(housekeeping_loop(settings)),
            asyncio.create_task(host_watch_loop()),
        ]
        if settings.auto_backup:
            tasks.append(asyncio.create_task(backup_loop(settings)))
        yield
        for task in tasks:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    app = FastAPI(
        title="Games Center",
        version=__version__,
        lifespan=lifespan,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        redoc_url=None,
    )
    app.include_router(public.router)
    app.include_router(admin.router)

    @app.middleware("http")
    async def no_stale_assets(request: Request, call_next):
        response = await call_next(request)
        if not request.url.path.startswith("/api/"):
            # always revalidate (ETag) so updates show up right after a redeploy
            response.headers.setdefault("Cache-Control", "no-cache")
        else:
            response.headers.setdefault("Cache-Control", "no-store")
        return response

    @app.websocket("/ws")
    async def websocket(ws: WebSocket, session: int | None = None, device: str | None = None):
        """?session=ID -> pushed session payloads (this phone's view); otherwise the live list."""
        device_id = valid_device_id(device)
        room = f"s:{session}" if session else LIVE_ROOM
        initial = await asyncio.to_thread(build_payload, session, device_id) if session else None
        await hub.serve(ws, room, device_id, on_message=touch, initial=initial)

    @app.get("/ca.crt", include_in_schema=False)
    def ca_download() -> Response:
        """The home CA (public certificate) - this content type makes phones offer to install it."""
        from .services.certs import ca_path

        path = ca_path()
        if not path.exists():
            return Response("No certificate uploaded yet (Admin -> Settings)", status_code=404)
        return Response(
            path.read_bytes(),
            media_type="application/x-x509-ca-cert",
            headers={
                "Content-Disposition": 'attachment; filename="home-ca.crt"',
                "Cache-Control": "no-cache",
            },
        )

    @app.get("/setup", include_in_schema=False)
    def setup_redirect() -> RedirectResponse:
        return RedirectResponse("/setup/")

    @app.get("/admin", include_in_schema=False)
    def admin_redirect() -> RedirectResponse:
        return RedirectResponse("/admin/")

    web: Path = settings.web_dir
    app.mount("/static", StaticFiles(directory=web / "shared"), name="static")
    app.mount("/games", StaticFiles(directory=settings.games_dir, html=True), name="games")
    app.mount("/admin/", StaticFiles(directory=web / "admin", html=True), name="admin")
    app.mount("/setup/", StaticFiles(directory=web / "setup", html=True), name="setup")
    app.mount("/", StaticFiles(directory=web / "shell", html=True), name="shell")
    return app


app = create_app()
