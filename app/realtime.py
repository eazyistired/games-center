"""WebSocket hub: phones subscribe to a session (or to the 'live' list) and get pushed updates.

Endpoints run in worker threads, so they call `hub.notify(session_id)` which schedules the
broadcast on the event loop. Each connection receives its *own* payload (multi-phone views are
per player), built fresh from the database.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

log = logging.getLogger(__name__)

LIVE_ROOM = "live"


@dataclass(eq=False)
class Conn:
    ws: WebSocket
    room: str
    device_id: str | None
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def send(self, payload: dict[str, Any]) -> None:
        async with self.send_lock:
            await self.ws.send_json(payload)


class Hub:
    def __init__(self) -> None:
        self.loop: asyncio.AbstractEventLoop | None = None
        self.rooms: dict[str, set[Conn]] = {}
        self._lock = threading.Lock()
        # builds the payload for one connection: (session_id, device_id) -> dict | None
        self.build_session_payload: Callable[[int, str | None], dict | None] | None = None

    # ---- connections
    def add(self, conn: Conn) -> None:
        with self._lock:
            self.rooms.setdefault(conn.room, set()).add(conn)

    def remove(self, conn: Conn) -> None:
        with self._lock:
            room = self.rooms.get(conn.room)
            if room:
                room.discard(conn)
                if not room:
                    self.rooms.pop(conn.room, None)

    def online_devices(self, session_id: int) -> set[str]:
        with self._lock:
            return {c.device_id for c in self.rooms.get(f"s:{session_id}", set()) if c.device_id}

    # ---- broadcasting (thread-safe entry point)
    def notify(self, session_id: int | None = None) -> None:
        if self.loop is None or self.loop.is_closed():
            return
        with contextlib.suppress(RuntimeError):  # loop shutting down
            self.loop.call_soon_threadsafe(
                lambda: self.loop.create_task(self._broadcast(session_id))  # type: ignore[union-attr]
            )

    async def _broadcast(self, session_id: int | None) -> None:
        with self._lock:
            live = list(self.rooms.get(LIVE_ROOM, set()))
            conns = list(self.rooms.get(f"s:{session_id}", set())) if session_id else []
        for c in live:
            await self._safe_send(c, {"type": "live", "session_id": session_id})
        for c in conns:
            payload = await asyncio.to_thread(self._payload, session_id, c.device_id)
            if payload is not None:
                await self._safe_send(c, payload)

    def _payload(self, session_id: int, device_id: str | None) -> dict | None:
        if self.build_session_payload is None:
            return None
        try:
            return self.build_session_payload(session_id, device_id)
        except Exception:  # pragma: no cover
            log.exception("building payload for session %s failed", session_id)
            return None

    async def _safe_send(self, conn: Conn, payload: dict) -> None:
        try:
            await conn.send(payload)
        except Exception:  # client went away
            self.remove(conn)

    # ---- one websocket
    async def serve(
        self,
        ws: WebSocket,
        room: str,
        device_id: str | None,
        on_message: Callable[[str | None], None] | None = None,
        initial: dict | None = None,
    ) -> None:
        await ws.accept()
        conn = Conn(ws=ws, room=room, device_id=device_id)
        self.add(conn)
        session_id = int(room[2:]) if room.startswith("s:") else None
        if session_id:
            self.notify(session_id)  # others see this phone come online
        try:
            if initial is not None:
                await conn.send(initial)
            while True:
                msg = await ws.receive_text()
                if on_message:
                    await asyncio.to_thread(on_message, device_id)
                if msg == "ping":
                    await conn.send({"type": "pong"})
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            self.remove(conn)
            if session_id:
                self.notify(session_id)  # ...and go offline
            with contextlib.suppress(Exception):
                await ws.close()


hub = Hub()
