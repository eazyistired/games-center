# 🎲 Games Center

A small self-hosted party-games hub for game nights with friends. One phone runs the
game; everyone's results land in shared leaderboards.

- **Live sessions:** running games show up under "Live now"; any phone can take a game over
  (the phone that has it, or another phone using the same name, is asked first).
- **Shared lineups:** pick who's playing from a pool of people, reload the last lineup (or a
  saved crew) in one tap, add/remove people, split into teams (shuffle or skill-balanced).
- **Leaderboards:** tonight / month / year / all time, overall and per game, game-night
  recaps, player profiles.
- **Admin dashboard:** players, sessions (edit scores, void, delete), nights, games, word
  decks, scoring settings, backups, audit log.
- **Games:** drop a folder into `games/`.
  - **Heads Up**: solo or teams, tilt or tap controls, pause, 9 built-in decks incl. IMDb Top
    250, + custom decks.
  - **Imposter**: everyone gets the secret word except the imposter; one-word clues, vote,
    last-chance guess. One phone or 📱📱 everyone's phones (secret voting). Shares the Heads Up
    decks.
  - **Three Rounds**: teams; the same pool of words is described, then clued with one word,
    then mimed. Shares the Heads Up decks.
  - **Tuned In**: teams; the clue-giver sees a hidden target between two extremes, the team
    turns a dial to find it, the other teams bet left/right.

Stack: Python 3.12 · FastAPI · SQLite (Alembic migrations) · plain HTML/JS (no build step).

## Quick start (local)

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
ADMIN_PASSWORD=dev uvicorn app.main:app --reload --port 8080
```

Open http://localhost:8080, then http://localhost:8080/admin to add people.

## Docs

- [docs/PLAN.md](docs/PLAN.md): the agreed plan & feature list
- [docs/DEPLOY.md](docs/DEPLOY.md): TrueNAS SCALE + Nginx Proxy Manager + Pi-hole
- [docs/ADDING_A_GAME.md](docs/ADDING_A_GAME.md): the game contract & SDK
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): project layout, tests, migrations
- [docs/IDEAS.md](docs/IDEAS.md): future fun features & games
- [docs/LIVE_SESSIONS.md](docs/LIVE_SESSIONS.md): live sessions, takeover & multi-phone plan

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `ADMIN_PASSWORD` | *(empty = admin disabled)* | Password for `/admin` |
| `TZ` | `UTC` | Timezone used to group games into nights |
| `NIGHT_CUTOFF_HOUR` | `6` | Games before this hour count for the previous night |
| `SITE_NAME` | `grzv's games` | Title shown in the app (Admin → Settings overrides it) |
| `DATA_DIR` | `/data` (container) | Where `games.db`, backups and the secret key live |
| `BACKUP_KEEP` | `14` | Number of automatic daily backups kept |
| `AUTO_BACKUP` | `true` | Daily SQLite backup into `DATA_DIR/backups` |
| `SECURE_COOKIES` | `false` | Set `true` when served over HTTPS |
| `SECRET_KEY` | *(auto-generated in DATA_DIR)* | Cookie signing key |
| `PORT` | `8080` | Listen port inside the container |
| `SESSION_IDLE_HOURS` | `2` | Default for "close idle games after" (Admin → Settings → Live games overrides it) |

Site name, timezone, night cutoff and scoring can also be changed later in **Admin → Settings**.
