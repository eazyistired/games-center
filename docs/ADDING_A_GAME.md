# Adding a game

A game is a folder `games/<id>/` with a `manifest.json` and static files. The shell handles
the lineup, settings and results. The game only plays and reports raw scores.

## 1. manifest.json
```json
{
  "id": "my-game",                  // must equal the folder name (lowercase slug)
  "name": "My Game",
  "emoji": "🎯",
  "description": "One line shown on the home screen",
  "min_players": 2,
  "max_players": 12,
  "modes": ["solo", "teams"],       // the first one is the default
  "teams": { "min": 2, "max": 4, "min_size": 1 },   // min_size = players per team
  "scoring": { "higher_is_better": true, "unit": "points" },
  "has_decks": false,               // true -> decks/*.json + admin deck editor
  "deck_source": null,              // or e.g. "heads-up": reuse another game's decks
  "entry": "index.html",
  "settings": [
    { "key": "rounds", "type": "select", "label": "Rounds", "default": 3,
      "options": [{ "value": 1, "label": "1" }, { "value": 3, "label": "3" }] },
    { "key": "hard", "type": "bool", "label": "Hard mode", "default": false },
    { "key": "target", "type": "number", "label": "Target", "default": 10 },
    { "key": "decks", "type": "decks", "label": "Decks", "default": [] }
  ]
}
```
Settings types: `select`, `bool`, `number`, `decks`. Values flow: manifest default → admin
default (Admin → Games) → choice on the start screen → `session.settings`.

## 2. index.html
```html
<link rel="stylesheet" href="/static/styles.css">   <!-- optional: shared look -->
<script src="/static/sdk.js"></script>
<script type="module">
  import { h, mount, toast } from "/static/ui.js";     // optional helpers
  const session = await GC.start();   // loads the session AND takes control of it (takeover UI)
  // session.mode, session.settings, session.participants[{player_id, name, emoji, team_idx}],
  // session.teams[{idx, name, color, player_ids}], session.progress (after a reload)
  // ... play ...
  // after every round/turn: makes refresh + takeover safe; 2nd arg = scores so far (auto-finish)
  await GC.saveProgress({ round: 2, scores }, { scores: [{ player_id: 1, score: 4 }] });
  await GC.submitResult({ scores: [{ player_id: 1, score: 12 }, ...], details: { summary: "…" } });
  // teams mode: scores: [{ team: 0, score: 5 }, { team: 1, score: 7 }]
  GC.exit();                                         // -> shared results screen
</script>
```

## SDK reference (`window.GC`)
| Call | What it does |
|---|---|
| `start({ onLost? })` | Load the session and become the phone driving it (shows the takeover screens if another phone has it, heartbeats, answers takeover requests, shows "continued on another phone") |
| `getSession()` | Session without taking control (read-only uses) |
| `saveProgress(state, partial?)` | Store any JSON (versioned; only the controlling phone may save); `partial` = `{scores, details}` so far, used to auto-finish idle sessions. A takeover resumes from the last save, so save at the end of every round/turn |
| `getWords()` | (deck games) shuffled words `[{id, text, deck, emoji}]`, words used tonight last |
| `submitResult({scores, details?, word_plays?})` | Finish the session; server computes placements & points |
| `exit()` | Go to the results screen |
| `quit()` | Abandon (not counted) and go home |
| `keepAwake()` | Screen wake lock; returns `release()` |

`details.summary` (a string) is shown on the results screen. Anything else in `details` is stored
for future stats.

## Game kit (optional)
`/static/gamekit.js` has the shared pieces: `createSound()`, `fit()` (shrink text to fit),
`countdown()`, `createTimer()` (pausable), `pauseOverlay()` (Resume with 3-2-1 + extra
actions), `onHidden()` (auto-pause when the phone locks), `goImmersive()`, `shuffle()`.

## Multi-phone games (optional)
1. Manifest: `"devices": ["single", "multi"]`.
2. Engine in `app/engines/<game>.py` (see the docstring in `app/engines/__init__.py`), add the
   module to `builtin` in `load_engines()`:
   ```python
   class MyGame(Engine):
       game_id = "my-game"
       def setup(self, ctx): ...                 # ctx.players, ctx.teams, ctx.settings, ctx.draw_words(n)
       def act(self, state, ctx, actor, action): ...  # actor.player_id / actor.is_host; raise ActionError
       def view(self, state, ctx, viewer): ...    # viewer.player_id None = spectator/TV: headline + scoreboard
       def result(self, state, ctx): ...          # {"scores": [...], "details": {...}} when over
   ```
3. Page: check `session.device_mode`; for `"multi"` use
   `GC.connect((session) => render(session.view))` and `GC.act({type: "vote", ...})`.
4. Test: see `tests/test_multi.py` + `tests/fixtures/demo_engine.py`. To click through it in a
   browser, start the server with `EXTRA_ENGINES=tests.fixtures.demo_engine` and a `GAMES_DIR`
   that also contains `tests/fixtures/games/demo-multi`.

## 3. Decks (optional)
`games/<id>/decks/<slug>.json`:
```json
{ "name": "Animals", "emoji": "🦁", "description": "…", "words": ["Dog", "Cat"] }
```
Built-in decks sync on startup (or Admin → Games → Reload). Removing a word from the file
deactivates it but keeps its stats.

## 4. Ship it
Commit, push to `main` → CI builds the image → redeploy the TrueNAS app. The game appears on
the home screen automatically (disable it in Admin → Games while it's work in progress).
