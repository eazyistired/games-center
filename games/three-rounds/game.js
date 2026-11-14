// Three Rounds - teams, one phone held by the clue-giver.
// Round 1: describe · Round 2: one word only · Round 3: mime only. Same pool of words every round.
import { h, mount, toast, confirmDialog, modal } from "/static/ui.js";
import { shuffle, createSound, fit, countdown, createTimer, pauseOverlay, onHidden, goImmersive } from "/static/gamekit.js";

const GC = window.GC;
const root = document.getElementById("game");

const ROUNDS = [
  { name: "Describe", emoji: "🗣️", rule: "Say anything except the word itself (no spelling, no \"sounds like\")." },
  { name: "One word", emoji: "☝️", rule: "Exactly ONE word as a clue. Choose wisely!" },
  { name: "Mime", emoji: "🤐", rule: "No words, no sounds: act it out." },
];
const CARRY_MIN_MS = 5000; // leftover time carried into the next round if at least this much

let session, teams, byId, sound;
const st = {
  words: [], // the game's pool [{id, text, deck, emoji}]
  round: 0, // 0..2, 3 = finished
  remaining: [], // word ids still to guess this round
  discarded: [], // skipped word ids: out for the rest of the game
  turnNo: 0,
  teamTurns: {},
  scores: {},
  perRound: [{}, {}, {}],
  perPlayer: {}, // words guessed while giving clues
  carry: null, // { team, player_id, ms }
  plays: [],
  log: [],
  roundIntro: true,
};

const wordById = (id) => st.words.find((w) => w.id === id);
const pName = (id) => byId.get(id)?.name || "?";
const pEmoji = (id) => byId.get(id)?.emoji || "🙂";
const teamOf = (idx) => teams.find((t) => t.idx === idx);
const save = () => {
  const partial = st.log.length ? {
    scores: teams.map((t) => ({ team: t.idx, score: st.scores[t.idx] || 0 })),
    details: { summary: `${st.log.length} turns played (round ${Math.min(st.round + 1, 3)})`, per_round: st.perRound },
  } : null;
  return GC.saveProgress({ ...st }, partial).catch(() => toast("Couldn't save progress (offline?)", "bad"));
};

function currentTurn() {
  if (st.carry) return { team: st.carry.team, player_id: st.carry.player_id, ms: st.carry.ms, carried: true };
  const team = teams[st.turnNo % teams.length];
  const n = st.teamTurns[team.idx] || 0;
  return { team: team.idx, player_id: team.player_ids[n % team.player_ids.length], ms: Number(session.settings.turn_seconds) * 1000 || 45000, carried: false };
}

function standingsList() {
  const rows = teams.map((t) => ({ t, score: st.scores[t.idx] || 0 })).sort((a, b) => b.score - a.score);
  return h("div", { class: "card tight list" }, rows.map(({ t, score }, i) => h("div", { class: "list-item" },
    h("span", { class: "muted", style: { width: "1.4rem" } }, i + 1),
    h("span", { class: "team-dot", style: { "--team": t.color } }),
    h("div", { class: "grow" }, h("b", null, t.name), " ", h("span", null, t.player_ids.map(pEmoji).join("")),
      h("div", { class: "rounds-mini" }, ROUNDS.map((r, ri) => h("span", null, `${r.emoji} ${st.perRound[ri]?.[t.idx] || 0}`)))),
    h("span", { class: "score" }, score))));
}

function rulesList() {
  return h("div", { class: "rules" }, ROUNDS.map((r, i) => h("div", { class: `rule ${i === st.round ? "now" : i < st.round ? "done" : ""}` },
    h("span", { class: "n" }, i + 1), h("div", null, h("b", null, `${r.emoji} ${r.name}`), h("span", { class: "small muted" }, r.rule)))));
}

async function menu() {
  const choice = await modal("Game menu", h("p", { class: "muted" }, "Finishing now saves the scores so far."), [
    { label: "Quit (don't save)", class: "danger", value: "quit" },
    { label: "Finish now", value: "finish" },
    { label: "Keep playing", class: "primary", value: null },
  ]);
  if (choice === "finish") return finalScreen();
  if (choice === "quit" && await confirmDialog("Quit game?", "This game won't count for the leaderboards.", "Quit", true)) GC.quit();
}

// ------------------------------------------------------------------ screens
function introScreen() {
  const resuming = st.turnNo > 0 || st.round > 0;
  mount(root, h("div", { class: "screen" }, h("div", { class: "wrap" },
    h("div", { class: "bar" },
      h("button", { class: "back", onclick: () => (resuming ? menu() : GC.quit()) }, "‹"),
      h("div", { class: "logo" }, "THREE ROUNDS"),
      h("span", { class: "badge" }, `${st.words.length} words`)),
    h("div", { class: "card stack" },
      h("h2", { style: { margin: 0 } }, resuming ? `Welcome back! Round ${st.round + 1}` : "How to play"),
      h("div", { class: "small muted stack", style: { gap: ".35rem" } },
        h("div", null, "📱 The clue-giver holds the phone; their team guesses. Teams take turns."),
        h("div", null, "🎩 The SAME words come back in every round, so remember them!"),
        h("div", null, "✅ Tap Got it for each word your team guesses."),
        h("div", null, `⏭️ Skips per turn: ${Number(session.settings.skips) >= 99 ? "unlimited" : session.settings.skips}. A skipped word is thrown out for the rest of the game.`),
        h("div", null, "⏩ If the pool runs out mid-turn, your leftover time carries into the next round."))),
    rulesList(),
    standingsList(),
    h("button", { class: "btn primary xl block", onclick: () => {
      sound.unlock();
      goImmersive();
      st.roundIntro ? roundIntroScreen() : handoffScreen();
    } }, resuming ? "▶ Continue" : "▶ Start"))));
}

function roundIntroScreen() {
  const r = ROUNDS[st.round];
  mount(root, h("div", { class: "screen centered" },
    h("span", { class: "round-chip" }, `Round ${st.round + 1} of 3`),
    h("div", { class: "round-emoji" }, r.emoji),
    h("div", { class: "big-round" }, r.name),
    h("p", { class: "muted", style: { maxWidth: "420px", fontSize: "1.1rem" } }, r.rule),
    h("div", { class: "pool-meter" }, `${st.remaining.length} words in the hat`),
    h("button", { class: "btn primary xl", style: { minWidth: "60%" }, onclick: () => { st.roundIntro = false; handoffScreen(); } }, "Let's go")));
}

function handoffScreen() {
  const turn = currentTurn();
  const team = teamOf(turn.team);
  const r = ROUNDS[st.round];
  mount(root, h("div", { class: "screen centered", style: { background: `linear-gradient(180deg, ${team.color}40, var(--bg) 70%)` } },
    h("div", { class: "bar abs" },
      h("button", { class: "btn small ghost", onclick: menu }, "☰ Menu"),
      h("span", { class: "badge" }, `${r.emoji} Round ${st.round + 1} · ${st.remaining.length} left`)),
    h("span", { class: "team-pill", style: { background: team.color } }, `Team ${team.name}`),
    h("div", { class: "muted" }, "Clue-giver: take the phone"),
    h("div", { class: "hand-emoji" }, pEmoji(turn.player_id)),
    h("div", { class: "hand-name" }, pName(turn.player_id)),
    turn.carried
      ? h("div", { class: "badge gold" }, `⏩ ${Math.round(turn.ms / 1000)}s left over from last round`)
      : h("div", { class: "small muted" }, `${team.player_ids.filter((id) => id !== turn.player_id).map(pName).join(", ")} guess${team.player_ids.length > 2 ? "" : "es"}`),
    h("div", { class: "small", style: { maxWidth: "420px" } }, h("b", null, `${r.emoji} ${r.name}: `), h("span", { class: "muted" }, r.rule)),
    h("button", { class: "btn primary xl", style: { minWidth: "60%" }, onclick: async () => {
      sound.unlock();
      const box = h("div", { class: "screen centered" });
      mount(root, box);
      await countdown(box, "Only you look at the screen!", sound);
      playScreen(turn);
    } }, "I'm ready"),
    h("div", { style: { width: "100%", maxWidth: "480px" } }, standingsList())));
}

function playScreen(turn) {
  const r = ROUNDS[st.round];
  const maxSkips = session.settings.skips == null ? 1 : Number(session.settings.skips);
  const total = Number(session.settings.turn_seconds) * 1000 || 45000;
  const pool = st.remaining.slice(); // local queue for this turn
  const items = []; // [{id, kind: correct|skip|timeout}]
  let current = pool[0];
  let busy = false;
  let ended = false;
  let skipsUsed = 0;

  const timerEl = h("span", { class: "timer" }, Math.ceil(turn.ms / 1000));
  const countEl = h("span", { style: { color: "#3ccf7f" } }, "0");
  const wordEl = h("div", { class: "word" });
  const deckEl = h("div", { class: "deck" });
  const center = h("div", { class: "center" });
  const progress = h("div", { style: { width: "100%" } });
  const skipBtn = h("button", { class: "btn danger", onclick: () => act("skip") });
  const play = h("div", { class: "play" },
    h("div", { class: "top" }, countEl, h("span", { class: "rule-hint" }, `${r.emoji} ${r.name}`), timerEl),
    center,
    h("div", null,
      h("div", { class: "controls" },
        skipBtn,
        h("button", { class: "gk-pause-btn", "aria-label": "Pause", onclick: () => pause() }, "⏸"),
        h("button", { class: "btn good", onclick: () => act("correct") }, "✓ Got it")),
      h("div", { class: "progress" }, progress)));
  mount(root, play);

  const drawSkip = () => {
    const left = maxSkips >= 99 ? "∞" : Math.max(0, maxSkips - skipsUsed);
    skipBtn.textContent = `Skip (${left})`;
    skipBtn.disabled = maxSkips < 99 && skipsUsed >= maxSkips;
  };
  const showWord = () => {
    const w = wordById(current);
    wordEl.textContent = w.text;
    deckEl.textContent = `${w.emoji} ${w.deck}`;
    mount(center, wordEl, deckEl);
    fit(wordEl);
  };
  drawSkip();
  showWord();

  const timer = createTimer(turn.ms, {
    onTick(left) {
      const secs = Math.ceil(left / 1000);
      if (timerEl.textContent !== String(secs)) {
        timerEl.textContent = secs;
        if (secs <= 5 && secs > 0) sound.tick();
      }
      timerEl.classList.toggle("low", secs <= 10);
      progress.style.width = `${(left / total) * 100}%`;
    },
    onEnd() { end("time"); },
  });
  const unHide = onHidden(() => pause());

  function act(kind) {
    if (busy || ended || timer.paused) return;
    if (kind === "skip" && maxSkips < 99 && skipsUsed >= maxSkips) return;
    busy = true;
    items.push({ id: current, kind });
    pool.shift();
    if (kind === "skip") { skipsUsed++; sound.skip(); } else sound.correct();
    countEl.textContent = items.filter((i) => i.kind === "correct").length;
    drawSkip();
    if (!pool.length) return end("pool");
    play.classList.add(kind);
    mount(center, h("div", { class: "feedback" }, kind === "correct" ? "✓" : "Skipped"));
    setTimeout(() => {
      play.classList.remove(kind);
      current = pool[0];
      if (!ended) showWord();
      busy = false;
    }, 350);
  }

  function pause() {
    if (ended || timer.paused) return;
    timer.pause();
    pauseOverlay(document.body, {
      subtitle: `${pName(turn.player_id)} · ${Math.ceil(timer.left() / 1000)}s left`,
      sound,
      resumeLabel: "Get ready!",
      onResume: () => timer.resume(),
      actions: [{ label: "⏹ End turn now", onclick: () => end("ended") }],
    });
  }

  function end(reason) {
    if (ended) return;
    ended = true;
    const msLeft = reason === "pool" ? timer.left() : 0;
    timer.stop();
    unHide();
    if (reason !== "pool" && current != null && !busy) items.push({ id: current, kind: "timeout" });
    sound.end();
    play.className = "play timeup";
    mount(play, h("div", { class: "center" }, h("div", { class: "feedback" },
      reason === "pool" ? "Hat's empty! 🎩" : reason === "time" ? "Time's up!" : "Turn ended")));
    setTimeout(() => reviewScreen(turn, items, reason, msLeft), 1100);
  }
}

function reviewScreen(turn, items, reason, msLeft) {
  const team = teamOf(turn.team);
  const state = items.map((i) => ({ ...i, correct: i.kind === "correct" }));
  const list = h("div", { class: "card tight" });
  const total = h("b");
  const tag = (s) => s.correct ? "guessed" : s.kind === "skip" ? "skipped: out of the game" : "back in the hat";
  const draw = () => {
    total.textContent = state.filter((s) => s.correct).length;
    mount(list, state.length ? state.map((s) => h("div", { class: `review-item ${s.correct ? "correct" : "miss"}`, onclick: () => { s.correct = !s.correct; draw(); } },
      h("div", { class: "t" }, wordById(s.id).text, h("div", { class: "tag" }, tag(s))),
      h("span", { class: "mark" }, s.correct ? "✓" : "✗"))) : h("p", { class: "muted center" }, "No words this turn."));
  };
  draw();
  mount(root, h("div", { class: "screen" }, h("div", { class: "wrap" },
    h("div", { class: "center" },
      h("span", { class: "team-pill", style: { background: team.color } }, `Team ${team.name}`),
      h("h2", { style: { margin: ".5rem 0 .25rem" } }, pEmoji(turn.player_id), " ", pName(turn.player_id), " · ", total, " guessed"),
      h("div", { class: "small muted" }, "Tap a word to fix a mistake.")),
    list,
    h("button", { class: "btn primary xl block", onclick: async (e) => {
      e.currentTarget.disabled = true;
      await applyTurn(turn, state, reason, msLeft);
    } }, "Confirm"))));
}

async function applyTurn(turn, state, reason, msLeft) {
  const correct = state.filter((s) => s.correct).map((s) => s.id);
  const skipped = state.filter((s) => !s.correct && s.kind === "skip").map((s) => s.id);
  const gone = new Set([...correct, ...skipped]);
  st.remaining = st.remaining.filter((id) => !gone.has(id));
  st.discarded.push(...skipped);
  st.scores[turn.team] = (st.scores[turn.team] || 0) + correct.length;
  st.perRound[st.round][turn.team] = (st.perRound[st.round][turn.team] || 0) + correct.length;
  st.perPlayer[turn.player_id] = (st.perPlayer[turn.player_id] || 0) + correct.length;
  for (const id of correct) st.plays.push({ word_id: id, result: "correct" });
  for (const id of skipped) st.plays.push({ word_id: id, result: "pass" });
  st.log.push({ round: st.round, team: turn.team, player_id: turn.player_id, correct: correct.length, skipped: skipped.length });

  const roundDone = st.remaining.length === 0;
  const carry = roundDone && reason === "pool" && msLeft >= CARRY_MIN_MS && st.round < 2
    ? { team: turn.team, player_id: turn.player_id, ms: msLeft } : null;
  if (!carry) { // the team's turn is over: move on to the next team
    st.turnNo++;
    st.teamTurns[turn.team] = (st.teamTurns[turn.team] || 0) + 1;
  }
  st.carry = carry;

  if (roundDone) {
    st.round++;
    const out = new Set(st.discarded);
    st.remaining = shuffle(st.words.map((w) => w.id).filter((id) => !out.has(id)));
    st.roundIntro = true;
    if (!st.remaining.length) st.round = 3; // everything was skipped
  }
  await save();
  if (st.round >= 3) return finalScreen();
  if (roundDone) return roundCompleteScreen();
  handoffScreen();
}

function roundCompleteScreen() {
  const done = ROUNDS[st.round - 1];
  sound.win();
  mount(root, h("div", { class: "screen" }, h("div", { class: "wrap" },
    h("div", { class: "center stack", style: { gap: ".4rem", marginTop: "1rem" } },
      h("div", { class: "round-emoji" }, "🎉"),
      h("h1", { style: { margin: 0 } }, `Round ${st.round}: ${done.name} done!`),
      h("div", { class: "muted" }, `Next: ${ROUNDS[st.round].emoji} ${ROUNDS[st.round].name} with the same ${st.remaining.length} words`)),
    standingsList(),
    st.carry && h("div", { class: "card small" }, `⏩ ${pName(st.carry.player_id)} keeps the phone with ${Math.round(st.carry.ms / 1000)}s left over.`),
    h("button", { class: "btn primary xl block", onclick: roundIntroScreen }, "Next round ▶"))));
}

function finalScreen() {
  const rows = teams.map((t) => ({ t, score: st.scores[t.idx] || 0 })).sort((a, b) => b.score - a.score);
  const mvp = Object.entries(st.perPlayer).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])[0];
  const totalGuessed = Object.values(st.scores).reduce((a, b) => a + b, 0);
  const summary = `${totalGuessed} words guessed over ${Math.min(st.round, 3)} round${st.round === 1 ? "" : "s"}` +
    (mvp ? ` · best clue-giver ${pName(Number(mvp[0]))} (${mvp[1]})` : "") +
    (st.discarded.length ? ` · ${st.discarded.length} skipped` : "");
  sound.win();
  mount(root, h("div", { class: "screen" }, h("div", { class: "wrap" },
    h("div", { class: "center" }, h("div", { style: { fontSize: "3.5rem" } }, "🏁"), h("h1", null, "Game over!"), h("div", { class: "muted" }, summary)),
    rows[0] && h("div", { class: "center", style: { fontSize: "1.4rem", fontWeight: 800 } }, `🏆 Team ${rows[0].t.name}`),
    standingsList(),
    h("button", { class: "btn primary xl block", onclick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await GC.submitResult({
          scores: teams.map((t) => ({ team: t.idx, score: st.scores[t.idx] || 0 })),
          word_plays: st.plays,
          details: { summary, per_round: st.perRound, per_player: st.perPlayer, turns: st.log, skipped: st.discarded.length },
        });
        GC.exit();
      } catch (err) { toast(err.message, "bad"); btn.disabled = false; }
    } }, "💾 Save & see results"),
    h("button", { class: "btn ghost block", onclick: menu }, "Menu"))));
}

// ------------------------------------------------------------------ boot
async function boot() {
  mount(root, h("div", { class: "screen centered" }, h("div", { class: "spinner" })));
  try {
    session = await GC.start();
  } catch (e) {
    mount(root, h("div", { class: "screen centered" }, h("h2", null, "😵 " + e.message), h("a", { class: "btn", href: "/" }, "Home")));
    return;
  }
  if (session.status !== "active") return GC.exit();
  sound = createSound(() => session.settings.sounds);
  teams = session.teams;
  byId = new Map(session.participants.map((p) => [p.player_id, p]));
  if (session.progress) {
    Object.assign(st, session.progress);
  } else {
    const all = await GC.getWords();
    const want = Math.max(8, (Number(session.settings.words_per_player) || 4) * session.participants.length);
    st.words = all.slice(0, want); // fresh words first (the API puts words used tonight last)
    st.remaining = shuffle(st.words.map((w) => w.id));
  }
  if (!st.words.length) {
    mount(root, h("div", { class: "screen centered" }, h("h2", null, "No words in the selected decks"), h("button", { class: "btn", onclick: () => GC.quit() }, "Back")));
    return;
  }
  introScreen();
}

boot();
