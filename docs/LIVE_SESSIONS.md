# Live sessions & multi-phone play: plan

## Goals
1. **One-phone play** (as today): one session per game at a time, passed around. Any phone can
   **take over** a running session (the bathroom case): it resumes at the start of the round.
2. **Multi-phone play** for games where it makes sense: everyone uses their own phone; one
   phone is the **host**.
3. **No codes**: one QR code to the site. People see live sessions and join from the app.
4. Everything stays documented per game night.

## Decisions
| Topic | Decision |
|---|---|
| Phones in multi-phone mode | Everyone needs a phone |
| Lineup | Host picks the lineup; people claim themselves ("I'm Ana") |
| Identity | No login. A phone remembers who it is (switchable). **One phone per name**: another phone needs the owner phone's OK while that phone was used within `name_hold_minutes` (default 30, Admin → Settings); afterwards the name frees up by itself. 3 denials → 5 min cooldown. Seats in multi-phone games move along with the name. Admin → Players → Release from phone. |
| Imposter on phones | Secret voting on each phone |
| Takeover | Anyone can take over; resumes at the start of the round/turn |
| Takeover confirmation | If the phone in control is active, it must approve. If the person taking over is active as the same player on another phone, that phone must approve too. A locked/quiet phone (no heartbeat for 30 s) counts as approved. |
| Spectating | Anyone can watch any live session (phase 2) |
| Host role (multi-phone) | Only the host can hand the 👑 to another joined player (no accept step); players can't request or take it. Everyone sees who the host is. If the host's phone leaves (offline + quiet) — in the lobby or mid-game — the next joined player becomes host automatically. Only the host (or, in one-phone games, the phone running the game) can discard a game. |
| Idle sessions | Nobody in control for 2 h: auto-finished with the scores so far if at least one round was completed, otherwise abandoned |
| Multi-phone rules | Server-side Python engines (secrets never reach the wrong phone, not even the host's) |
| TV view | Planned (spectator/board view) |

## Architecture
```
                    ┌──────────── server (FastAPI) ─────────────┐
host phone  ◄─────► │ session state (DB, versioned)              │
player phone◄─────► │ multi-phone engines (Python, phase 2+)      │
player phone◄─────► │ devices: who is who, who controls, last seen│
                    └────────────────────────────────────────────┘
```
- **Device**: an anonymous random id stored on the phone (`localStorage`) and sent as the
  `X-Device-Id` header. The server keeps `devices(id, player_id, last_seen)`.
- **Controller**: in one-phone play, the device driving the session. It heartbeats every 5 s;
  "paused" = no heartbeat for 30 s. Only the controller can save progress or finish the session
  (state is versioned, a stale phone gets a conflict).
- **Takeover requests**: stored server-side; approvers learn about them through their heartbeat
  and answer with Allow/Deny.
- **Phase 2** adds WebSockets (live updates), the lobby, spectator/TV views and the Python engine
  framework (`initial_state`, `apply(action)`, `view(player)`).

## Session statuses
`playing` (controller active) · `paused` (no controller heartbeat) · `finished` · `abandoned` ·
`void` (admin). Phase 2 adds `lobby` (multi-phone, waiting for players).

## Where sessions appear
- **Home → 🔴 Live now**: active sessions, "you're in this one" highlighted.
- **Nights → night**: every session of that night with a status chip; live ones open the
  session page, finished ones open the results.
- **Session page**: status, players, which phone controls it, **Take over** / back to game /
  (phase 2) **Join as Ana** and **Watch**.
- **Invite**: a page with a big QR code of the site address.

## Phases
1. **Live sessions foundation** (one-phone)
   - Device identity + "Who are you?" (remembered, switchable)
   - Controller heartbeat, versioned saves, takeover with confirmations, "continued on another
     phone" screen
   - Live now on Home, statuses on Nights, session page, Invite QR, auto-finish idle sessions
   - Build/version stamp (`/api/health`, admin dashboard)
   - All four games use it (resume at the start of the round)
2. **Multi-phone layer** ✅
   - WebSockets on `/ws` (`?session=ID` = this phone's payload pushed on every change;
     no session = "live" nudges for Home/Nights), auto-reconnect, ping every 15 s
   - Start screen: 📱 One phone / 📱📱 Everyone's phones (games whose manifest lists
     `"devices": ["single", "multi"]` and that have an engine)
   - Lobby on the session page: seats with joined/online, "Join as Ana" / "That's me"
     (claiming a seat also sets who the phone is), host 👑 removes people, Start when all joined;
     a seat held by another active phone can't be taken (the host can move it)
   - Engines (`app/engines`): `setup`, `act`, `view(viewer)`, `result`, `partial`; raw state
     never leaves the server (`progress` is hidden for multi-phone sessions)
   - Watch / 📺 TV mode for any live game (scoreboard + headline, live)
3. **Imposter multi-phone** ✅ (`app/engines/imposter.py`, `games/imposter/multi.js`)
   - Phases: reveal (hold your own card, "Got it") → clues (phones show the order and "Your
     turn") → discuss (timer; host starts the vote or asks for another lap) → secret vote (can be
     changed until everyone voted; one runoff on a tie, still tied = nobody caught) → caught
     imposter types the word (exact match ignoring case/accents counts, otherwise the host
     judges) → reveal with who voted for whom
   - Host menu: new word (redo round), finish now. Same points as the one-phone game.
   - "Play again" from several phones reuses the open lobby
4. **Tuned In multi-phone** ✅ (`app/engines/tuned_in.py`, `games/tuned-in/multi.js`)
   - Clue phase: only the clue-giver's phone gets the card + target (swap card); others wait
   - The clue-giver's teammates drag the needle on their own phones (throttled, ~8 updates/s),
     it moves live on every phone and on the TV; anyone on the team locks it in
   - Other teams bet ◀/▶ from their phones (host can reveal early); reveal on every phone;
     the clue-giver or host goes on. Same scoring / "play to" rule as the one-phone game
   - The dial is shared (`web/shared/dial.js`) by the one-phone game, the phones and the TV
5. **Three Rounds multi-phone** ✅ (`app/engines/three_rounds.py`, `games/three-rounds/multi.js`)
   - The clue-giver plays on their own phone: only that phone gets the word (Got it / Skip /
     pause / review); everyone else sees the round rule, live timer, the team's count, the hat
   - The server keeps the clock (3 s countdown, 1.5 s grace at the buzzer); host can end a turn
     if the clue-giver's phone disappears. Same rules as one phone (skips leave the game,
     time-out word back in the hat, leftover time carries into the next round, friends' words)
6. **Later**: late join ("ask to join"), parallel sessions polish, night scoreboard on TV
