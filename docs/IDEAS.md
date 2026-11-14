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
1. **Scorekeeper**: pick a physical board/card game, lineup, enter scores → leaderboards for
   game nights that don't use the phone (lowest-wins option for golf-style games).
2. **Imposter / word-spy**: pass the phone; everyone sees the secret word except one person;
   discuss, vote. Reuses decks.
3. **Trivia**: question packs (JSON), single device quizmaster mode.
4. **Fishbowl-style 3 rounds** (describe → one word → mime) reusing Heads Up decks.
5. **Multi-device games** (drawing & guessing, werewolf roles): needs WebSockets; each phone
   joins via QR code.
