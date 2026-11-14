# Development

```
app/
  main.py            app factory, static mounts, startup (migrations, game/deck sync, backups)
  config.py          environment settings
  db.py, models.py   SQLAlchemy engine & ORM models
  migrate.py         runs Alembic on startup
  migrations/        Alembic env + versions/
  auth.py            admin password -> signed cookie
  realtime.py        WebSocket hub (/ws): per-session rooms + the "live" list
  engines/           server-side rules for multi-phone games
  api/public.py      player-facing API (no login)
  api/admin.py       admin API
  services/          registry (manifests), sessions, scoring, leaderboards, nights, decks,
                     backup, runtime settings, audit
web/
  shared/            styles.css, ui.js (DOM helpers), api.js, sdk.js, emoji.js, icons
  shell/             player SPA (hash router): app.js + views/
  admin/             admin SPA
games/<id>/          one folder per game (see ADDING_A_GAME.md)
tests/               pytest
```

## Run & test
```bash
pip install -r requirements-dev.txt
ADMIN_PASSWORD=dev uvicorn app.main:app --reload --port 8080   # data goes to ./data
pytest -q
ruff check app tests && ruff format app tests
```
Interactive API docs: http://localhost:8080/api/docs

## Changing the database schema
1. Edit `app/models.py`
2. `alembic revision --autogenerate -m "what changed"` (uses `./data/games.db`, so run the app
   once first so the DB is at the latest revision)
3. Review the generated file in `app/migrations/versions/`, commit it. Migrations run
   automatically when the container starts.

## Frontend notes
- No build step: plain ES modules, served with `Cache-Control: no-cache` (ETag revalidation), so
  a redeploy is picked up on the next load.
- `h(tag, props, ...children)` in `web/shared/ui.js` builds DOM. Keep views small.
- Test on a phone over HTTPS: motion sensors and wake lock need a secure context.
