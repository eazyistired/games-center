# Future ideas

## Fun stats & awards
- **Badges / titles**: Pass Master (most passes), Speed Demon (best words/min), Comeback Kid
  (won after being last at half-time), Iron Player (most nights attended), Always the
  Bridesmaid (most 2nd places), Word Wizard (most words in one turn).
- **Head-to-head**: win record vs each other player; **nemesis** (who beats you most) and
  **favourite victim**.
- **Best duo**: team-mode win rate per pair of teammates.
- **Streaks**: consecutive wins, nights in a row on the podium.
- **End-of-night awards**: slideshow on the host phone (MVP + fun awards), generated from the
  night's sessions and `details`.
- **Seasons**: monthly champion, hall of fame page.
- **Elo / TrueSkill rating** as an alternative ranking; better team balancing.
- **Shareable recap image** of the night for the group chat (rendered client-side to PNG).
- **Word stats**: per-player "words you always pass", deck difficulty ranking.

Most of these only need data that is already stored (`session_participants`, `session_teams`,
`word_plays`, `sessions.details`), so they can be built without schema changes.

## Games
- ✅ **Majority / minority** → built as **Popular Opinion** (a "minority" variant could come later).
- **Rank it**: the TV shows 5 items, everyone orders them on their phone ("worst to best
  snack"); you score for how close your order is to the group's average order. Multi-phone + TV.

1. **Scorekeeper**: pick a physical board/card game, lineup, enter scores → leaderboards for
   game nights that don't use the phone (lowest-wins option for golf-style games).
2. **Imposter / word-spy**: pass the phone; everyone sees the secret word except one person;
   discuss, vote. Reuses decks.
3. **Trivia**: question packs (JSON), single device quizmaster mode.
4. **Fishbowl-style 3 rounds** (describe → one word → mime) reusing Heads Up decks.
5. **Multi-device games** (drawing & guessing, werewolf roles): needs WebSockets; each phone
   joins via QR code.

## Left to do (as of the friends-words feature)
- [x] **Phase 4: Tuned In on everyone's phones** (private target, live needle, bets, TV dial)
- [x] **Phase 5: Three Rounds on everyone's phones** (clue-giver's own phone, live timer/score)
- [ ] **Late join** ("ask to join" a running multi-phone game)
- [x] **Night scoreboard on the TV** (`#/tv`)
- [ ] **Custom scale cards** for Tuned In (admin + friends' cards)
- [ ] **Scorekeeper** for physical board games
- [x] Fun stats: badges, head-to-head, nemesis / best teammate, night awards, hall of fame
- [ ] More fun: end-of-night awards slideshow, shareable recap image, Elo rating
- [ ] **Real-phone tuning** after a few game nights: Heads Up tilt thresholds, "quiet after"
      seconds (Admin → Settings), takeover timing
- [ ] `docs/HOME_SERVER.md`: fill in the items marked **(verify)** (app dataset path, host port)
- [x] HTTPS on phones: NPM on 443, home CA, setup QR in the admin panel
- [ ] GitHub: delete the old remote branches `design-refresh`, `imposter-game`,
      `three-rounds`, `tuned-in` (this Claude session can't delete remote branches)

## Backlog from the games review (Nov 2026)

Recommended order: card rotation + content → late join / remove player → per-game TV screens.

### Quick wins
- [ ] **No repeats across nights**: Popular Opinion (108 q, 8/game) and Tuned In (143 scales) draw
      at random every time. Prefer cards not seen recently (store per-card last-used), show
      "% fresh" per deck in the admin panel.
- [ ] **More content**: Popular Opinion → ~250 (themes + a "this group" category),
      Tuned In → ~250 scales.
- [ ] **Late join + leave**: "Ask to join" a running multi-phone game (host approves);
      "Remove player" in the host menu; engines skip removed players in turn order.
- [ ] **Real-phone tuning**: tilt thresholds, "quiet after", timer defaults; a "report a
      problem" button in the host menu that sends the session state for debugging.

### Per game
- [ ] **Heads Up**: multi-phone mode (others see the word on their phones and can follow
      along / catch cheating); "words you got" recap after each turn; mime-only deck option.
- [ ] **Imposter**: two related words variant (crew "Beach", imposter "Pool"; the imposter
      doesn't know); "category only" hint for the imposter at a set difficulty.
- [ ] **Three Rounds**: words-each-team-got recap after a round; optional 4th round
      (sounds only / one word under a blanket); "steal" (other team gets one guess when time runs out).
- [ ] **Tuned In**: friends write the scales (reuse the friends-words flow); everyone-for-themselves
      mode (each phone places its own guess, scored by distance).
- [ ] **Popular Opinion**: minority variant (score for the least popular answer);
      "who said it?" round using earlier answers; questions with 3–4 options.

### New games (reuse existing parts)
- [ ] **Rank It** (5 items, order them on your phone, TV shows the group average).
- [ ] **Most Likely To…** (secret vote for a player, TV reveal; pairs with spicy mode).
- [ ] **Scorekeeper** for physical board games (lowest-wins option).
- [ ] **Trivia** with question packs (phones as answer buttons, question on the TV).

### TV
- [ ] **Per-game TV screens**: Tuned In dial, Popular Opinion vote bars, Three Rounds
      timer/score, Imposter "who voted for whom" reveal. Mostly an extra "tv" view per engine.

### End of night & stats
- [ ] Awards slideshow on the TV at the end of the night (MVP + the fun awards already computed).
- [ ] Shareable recap image for the group chat.
- [ ] Elo rating next to placement points; auto-balanced teams in the lineup picker.

### Housekeeping
- [ ] Delete old remote branches (`design-refresh`, `imposter-game`, `three-rounds`, `tuned-in`).
- [ ] Decide on the local `setup-open-button` WIP branch.
- [ ] Automatic SQLite backups to a TrueNAS dataset (check what `app/services/backup.py` already covers).
