"""FastAPI application: API + static shell, admin and games."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .api import admin, public
from .config import Settings, get_settings
from .db import SessionLocal, init_engine
from .migrate import run_migrations
from .services import backup as bk
from .services.decks import sync_builtin_decks
from .services.registry import load_manifests, sync_games

log = logging.getLogger("games_center")


def startup(settings: Settings) -> None:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    init_engine(settings.db_path)
    run_migrations(settings.db_path)
    load_manifests(settings.games_dir)
    with SessionLocal() as db:
        sync_games(db)
        sync_builtin_decks(db, settings.games_dir)
        db.commit()


def close_idle(settings: Settings) -> None:
    from .services.live import close_idle_sessions

    with SessionLocal() as db:
        result = close_idle_sessions(db, settings.idle_hours)
        db.commit()
    if any(result.values()):
        log.info("idle sessions closed: %s", result)


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
        tasks = [asyncio.create_task(housekeeping_loop(settings))]
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

    @app.get("/admin", include_in_schema=False)
    def admin_redirect() -> RedirectResponse:
        return RedirectResponse("/admin/")

    web: Path = settings.web_dir
    app.mount("/static", StaticFiles(directory=web / "shared"), name="static")
    app.mount("/games", StaticFiles(directory=settings.games_dir, html=True), name="games")
    app.mount("/admin/", StaticFiles(directory=web / "admin", html=True), name="admin")
    app.mount("/", StaticFiles(directory=web / "shell", html=True), name="shell")
    return app


app = create_app()
