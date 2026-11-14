# Games Center: Plan

## Decisions
| Topic | Decision |
|---|---|
| Devices | One host phone runs the game and is passed around (multi-device later) |
| Players | ~30 people in the pool, ~7 per session. No logins: name + emoji |
| User management | Admin web UI (not a JSON file) |
| Language | English |
| Stack | Python/FastAPI, SQLite, plain HTML/JS modules, no build step |
| Look | Warm dark palette: near-black `#14110f`, cream text, gold `#f5c518` accent (tokens in `web/shared/styles.css`) |
| Hosting | Docker image on GHCR (GitHub Actions) → TrueNAS SCALE custom app (YAML) → Nginx Proxy Manager (HTTPS) → Pi-hole local DNS |
| Domain | `games.grzv.local` |

## Architecture
```
phone ──► Pi-hole DNS ──► Nginx Proxy Manager (HTTPS) ──► games-center container :8080
                                                           ├── /              shell (player UI)
                                                           ├── /admin/        admin dashboard
                                                           ├── /games/<id>/   static game folders
                                                           ├── /static/       shared CSS/JS + SDK
                                                           ├── /api/...       JSON API (/api/docs)
                                                           └── /data          TrueNAS dataset (SQLite + backups)
```

## Data model
players · game_nights · games (admin state per manifest) · sessions · session_teams ·
session_participants · crews (saved lineups) · decks · words · word_plays · settings · audit_log

## Scoring
Games report **raw scores** only. The server ranks entries (players, or teams in team mode) and
awards **placement points**: `100 × (beaten + (tied − 1)/2) / (N − 1)`. The winner gets 100, last
gets 0, ties share. Team members all get their team's points. The overall ranking is the
**average points per game** (min. games configurable; default 3). Alternative formula:
winner-takes-all. Changing the formula recalculates history.

## Features

### Shell (player-facing)
- [x] Home: game tiles, "tonight so far", resume/discard unfinished game
- [x] Lineup picker: recent lineups per game, saved crews, people pool with search, solo/teams,
      team count, shuffle, skill-balance (snake draft by avg points), tap to move between teams,
      rename teams
- [x] Generic per-game settings form rendered from the manifest
- [x] Results: podium, placements, points, tonight's standings, **Play again (same lineup)**,
      edit lineup, other game
- [x] Leaderboards: tonight/month/year/all time × overall/per game
- [x] Game nights list + recap, people list, player profiles (stats, per game, recent, streak)
- [x] Add-to-home-screen manifest & icons

### Admin
- [x] Password login (signed cookie, 30 days; changing the password logs everyone out)
- [x] Dashboard: totals, most played, recent sessions, backup status
- [x] Players: add (emoji picker), bulk add, edit, archive/restore, merge, delete (if unused)
- [x] Sessions: filter, edit scores/participants/teams/night, void/restore, delete, clean up
- [x] Nights: rename, change date, merge, delete empty
- [x] Games: enable/disable, order, default settings, reload from disk
- [x] Decks: enable/disable decks & words, custom decks (create/rename/add/delete), word stats,
      hardest words
- [x] Settings: site name, timezone, night cutoff, scoring formula, min games, recalculate
- [x] Backups: automatic daily, manual, download, JSON export/import
- [x] Audit log

### Heads Up
- [x] Solo (score per guesser) and teams (teams alternate, members rotate, team score)
- [x] Tilt down = correct, tilt up = pass (DeviceOrientation, DeviceMotion fallback), live
      sensor test screen + per-phone "flip tilt direction", tap controls as fallback / option
- [x] 3-2-1 countdown, timer with last-5s ticks, sounds, vibration, wake lock, fullscreen
- [x] Review screen to fix misread tilts; last word when time runs out is reviewable
- [x] No repeated words within a night; progress saved after every turn (refresh-safe)
- [x] Finish early / quit from the menu
- [x] ⏸ Pause during a turn (word hidden, timer frozen; auto-pause when the phone locks) with
      **End turn now** → that player's review, game continues; Resume runs a 3-2-1 countdown
      with the word still hidden
- [x] 9 built-in decks (980 words, incl. IMDb Top 250) + custom decks from admin
- [x] Long words/titles auto-shrink to fit the screen

## Milestones
1. **M1 Foundation** ✅
2. **M2 Heads Up** ✅
3. **M3 Polish:** first real game night → fix what hurts
4. **M4+:** Scorekeeper, then the ideas in [IDEAS.md](IDEAS.md)
