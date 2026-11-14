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
- **Majority / minority**: a question ("Pineapple on pizza?"), everyone picks secretly on their
  phone; you score for guessing what most people picked (or a "minority" variant). Multi-phone.
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
- [ ] **Phase 4: Tuned In on everyone's phones**: private target on the clue-giver's phone, live
      needle on every phone, bets from phones, TV dial view
- [ ] **Phase 5: Three Rounds on everyone's phones**: clue-giver uses their own phone, live
      timer and score
- [ ] **Late join** ("ask to join" a running multi-phone game) and **night scoreboard on the TV**
- [ ] **Custom scale cards** for Tuned In (admin + friends' cards)
- [ ] **Scorekeeper** for physical board games
- [ ] Fun stats: badges, head-to-head, end-of-night awards, seasons (see above)
- [ ] **Real-phone tuning** after a few game nights: Heads Up tilt thresholds, "quiet after"
      seconds (Admin → Settings), takeover timing
- [ ] `docs/HOME_SERVER.md`: fill in the items marked **(verify)** (app dataset path, host port)
- [x] HTTPS on phones: NPM on 443, home CA, setup QR in the admin panel
- [ ] GitHub: delete the old remote branches `design-refresh`, `imposter-game`,
      `three-rounds`, `tuned-in` (this Claude session can't delete remote branches)
