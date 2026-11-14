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
| Identity | No login. A phone remembers who it is (switchable). |
| Imposter on phones | Secret voting on each phone |
| Takeover | Anyone can take over; resumes at the start of the round/turn |
| Takeover confirmation | If the phone in control is active, it must approve. If the person taking over is active as the same player on another phone, that phone must approve too. A locked/quiet phone (no heartbeat for 30 s) counts as approved. |
| Spectating | Anyone can watch any live session (phase 2) |
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
2. **Multi-phone layer**: WebSockets + reconnect, lobby, claiming, Python engine framework,
   spectator/TV view
3. **Imposter multi-phone**: private cards, clue order, secret voting, typed guess
4. **Tuned In multi-phone**: private target, live needle, bets from phones, TV dial
5. **Three Rounds multi-phone**: clue-giver's own phone, live timer/score
6. **Later**: late join ("ask to join"), parallel sessions polish, night scoreboard on TV
