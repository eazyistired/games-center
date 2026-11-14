# Games Center

Self-hosted party games hub. FastAPI + SQLite backend (`app/`), no-build vanilla JS frontend
(`web/`), games as static folders (`games/<id>/` with `manifest.json`).

- Run: `ADMIN_PASSWORD=dev .venv/bin/uvicorn app.main:app --reload --port 8080`
- Test: `.venv/bin/pytest -q` · Lint: `.venv/bin/ruff check app tests && .venv/bin/ruff format app tests`
- Schema change → edit `app/models.py` → `alembic revision --autogenerate -m "..."`, commit the migration.
- Games only report raw scores via `window.GC` (`web/shared/sdk.js`); placements/points are
  computed server-side (`app/services/scoring.py`).
- Docs: `docs/PLAN.md` (feature list), `docs/ADDING_A_GAME.md`, `docs/DEPLOY.md`.
- Branches: only `main` and `dev` are long-lived. Work on a feature branch off `dev`, merge it
  into `dev` (`--no-ff`), delete it; `dev` → `main` when the user asks.
- Live sessions: see `docs/LIVE_SESSIONS.md` (games boot with `GC.start()`).
