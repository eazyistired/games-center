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

### Imposter
- [x] Pass the phone; press-and-hold card reveals the secret word (or "You're the IMPOSTER")
- [x] 1 or 2 imposters (capped so the crew is always the majority), optional category hint for
      the imposter, imposter role rotates (no repeats in a row)
- [x] Clue lap with a random starting player, optional discussion timer (2/3/5 min)
- [x] Group vote → reveal → caught imposter gets a last guess at the word
- [x] Points: +2 imposter escapes · +1 caught imposter who guesses the word · +1 each crew
      member per caught imposter who misses
- [x] Uses the Heads Up decks (incl. custom ones), no word repeats within a night; menu:
      new word (redo round), finish now, quit

### Three Rounds
- [x] Teams only (2–4 teams, min. 2 players per team); the clue-giver holds the phone
- [x] One pool of words (words per player × players), reused in all three rounds:
      🗣️ Describe → ☝️ One word → 🤐 Mime
- [x] Teams alternate, clue-giver rotates within the team; Got it / Skip buttons, timer, pause
      with End turn now
- [x] Skips per turn (0/1/2/unlimited); a skipped word is thrown out for the rest of the game;
      the word on screen when time runs out goes back in the hat
- [x] Leftover time carries over into the next round when the hat empties mid-turn
- [x] Review after every turn (fix mistakes); per-round scores; best clue-giver
- [x] Score = words guessed by the team over all three rounds; uses the Heads Up decks

### Tuned In
- [x] Teams only (2–4 teams, min. 2 players per team); clue-giver rotates within the team
- [x] Clue-giver secretly sees a target on a dial between two extremes (143 original scale
      cards), may swap the card (0/1/2 swaps), then says one clue
- [x] Team drags the needle (with fine-tune buttons) and locks it in
- [x] Other teams bet left/right of the needle (+1 if right; no bet wins against a bullseye)
- [x] Scoring: bullseye 4 · close 3 · near 2; play to 10/15/20, checked after equal turns,
      sole leader wins
- [x] No repeated cards within the game / tonight on that phone

### Live sessions (phase 1 of [LIVE_SESSIONS.md](LIVE_SESSIONS.md))
- [x] "Who are you?" per phone (remembered, switchable; "This is me" on profiles)
- [x] Controller phone + heartbeat; versioned saves; Take over (needs approval from an active
      controller and from another active phone using the same name; quiet phones = approved)
- [x] Live now on Home, live sessions + status chips on Nights, session page, Invite QR
- [x] Starting a game that's already running offers to go to it
- [x] Idle sessions (2 h) auto-finish with the scores so far, or are abandoned
- [x] Build version in Admin and /api/health

### Multi-phone layer (phase 2 of [LIVE_SESSIONS.md](LIVE_SESSIONS.md))
- [x] WebSockets with auto-reconnect; Home / Nights / session pages update live
- [x] One phone / Everyone's phones choice on the start screen (for games that support it)
- [x] Lobby: seats, join as yourself, host controls, start when everyone has joined
- [x] Server-side game engines (secrets never reach the wrong phone)
- [x] Watch live + 📺 TV mode for any running game

### Imposter on everyone's phones (phase 3)
- [x] Private cards, clue turns on the phones, discussion timer, secret voting with one runoff,
      typed guess (host judges near misses), reveal with votes; TV shows the reveal

### Friends write the words
- [x] "✍️ Friends write the words" setting (Heads Up, Imposter, Three Rounds; one phone or
      everyone's phones), words per person 3/5/8/10
- [x] Collecting phase: everyone adds words from their own phone (Live now → the game); only
      your own words are ever sent to your phone, others see counts; host starts with enough words
- [x] Fair play: Heads Up never shows you your own word; Imposter never makes the word's author
      the imposter
- [x] After the game: pop-up "Save the friends' words?" → a normal custom deck (shared by the
      word games, editable in Admin → Decks)

## Milestones
1. **M1 Foundation** ✅
2. **M2 Heads Up** ✅
3. **M3 Polish:** first real game night → fix what hurts
4. **M4+:** Scorekeeper, then the ideas in [IDEAS.md](IDEAS.md)
