// Imposter - one phone, passed around. Everyone sees the secret word except the imposter(s).
import { h, mount, toast, confirmDialog, modal } from "/static/ui.js";

const GC = window.GC;
const root = document.getElementById("game");

// points per round
const PTS = { escaped: 2, guessed: 1, crew: 1 };

let session, players, byId, words = [], wordPos = 0, nImp = 1;
const st = { round: 0, scores: {}, history: [], usedIds: [], plays: [], lastImposters: [] };
let round = null; // { word, imposters: [ids], starter, order: [ids] }

// ------------------------------------------------------------------ helpers
const pName = (id) => byId.get(id)?.name || "?";
const pEmoji = (id) => byId.get(id)?.emoji || "🙂";
const rounds = () => Number(session.settings.rounds) || 5;
const shuffle = (a) => {
  const arr = a.slice();
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
};

let actx = null;
function beep(freq, dur = 0.15, type = "sine", gain = 0.18, when = 0) {
  if (!session?.settings.sounds || !actx) return;
  const t = actx.currentTime + when;
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(actx.destination); o.start(t); o.stop(t + dur + 0.02);
}
function unlockAudio() {
  try { actx ||= new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === "suspended") actx.resume(); } catch { /* no audio */ }
}
const sfx = {
  reveal() { beep(520, 0.08, "triangle", 0.12); },
  end() { beep(180, 0.6, "sawtooth", 0.14); try { navigator.vibrate?.(400); } catch { /* ignore */ } },
  win() { beep(660, 0.12, "triangle"); beep(990, 0.25, "triangle", 0.18, 0.1); },
  lose() { beep(300, 0.2, "square", 0.1); beep(200, 0.35, "square", 0.1, 0.18); },
};

function nextWord() {
  if (wordPos >= words.length) { words = shuffle(words); wordPos = 0; }
  return words[wordPos++];
}

function pickImposters() {
  // avoid giving the role to the same person twice in a row when possible
  const pool = players.map((p) => p.player_id);
  const fresh = shuffle(pool.filter((id) => !st.lastImposters.includes(id)));
  const rest = shuffle(pool.filter((id) => st.lastImposters.includes(id)));
  return [...fresh, ...rest].slice(0, nImp);
}

function newRound() {
  const order = players.map((p) => p.player_id);
  // rotate who looks first each round
  const shift = st.round % order.length;
  round = {
    word: nextWord(),
    imposters: pickImposters(),
    order: [...order.slice(shift), ...order.slice(0, shift)],
    starter: order[Math.floor(Math.random() * order.length)],
  };
}

/** Current standings; `pending` = points from the round being shown (not saved yet). */
function standings(pending = {}) {
  return players.map((p) => ({ id: p.player_id, name: p.name, emoji: p.emoji, score: (st.scores[p.player_id] || 0) + (pending[p.player_id] || 0) }))
    .sort((a, b) => b.score - a.score);
}

function standingsList(deltas = {}) {
  return h("div", { class: "card tight list" }, standings(deltas).map((s, i) => h("div", { class: "list-item" },
    h("span", { class: "muted", style: { width: "1.5rem" } }, i + 1),
    h("span", { style: { fontSize: "1.3rem" } }, s.emoji),
    h("span", { class: "grow", style: { fontWeight: 650 } }, s.name),
    h("span", { class: "score" }, s.score, deltas[s.id] ? h("span", { class: "delta" }, `+${deltas[s.id]}`) : null))));
}

function save() {
  const partial = st.round > 0 ? {
    scores: players.map((p) => ({ player_id: p.player_id, score: st.scores[p.player_id] || 0 })),
    details: { summary: `${st.round} round${st.round === 1 ? "" : "s"} played`, rounds: st.history },
  } : null;
  return GC.saveProgress({ ...st }, partial).catch(() => toast("Couldn't save progress (offline?)", "bad"));
}

async function menu() {
  const choice = await modal("Game menu", h("p", { class: "muted" }, "Finishing now saves the points from the rounds played so far."), [
    { label: "Quit (don't save)", class: "danger", value: "quit" },
    round && { label: "New word (redo round)", value: "redo" },
    { label: "Finish now", value: "finish" },
    { label: "Keep playing", class: "primary", value: null },
  ].filter(Boolean));
  if (choice === "finish") return finalScreen();
  if (choice === "redo") { newRound(); return handoffScreen(0); }
  if (choice === "quit" && await confirmDialog("Quit game?", "This game won't count for the leaderboards.", "Quit", true)) GC.quit();
}

const topBar = (label) => h("div", { class: "bar" },
  h("button", { class: "btn small ghost", onclick: menu }, "☰ Menu"),
  h("span", { class: "badge" }, label || `Round ${st.round + 1} / ${rounds()}`));

// ------------------------------------------------------------------ screens
function introScreen() {
  const resuming = st.round > 0;
  mount(root, h("div", { class: "screen" }, h("div", { class: "wrap" },
    h("div", { class: "bar" },
      h("button", { class: "back", onclick: () => (resuming ? menu() : GC.quit()) }, "‹"),
      h("div", { class: "logo" }, "IMPOSTER"),
      h("span", { class: "badge" }, `${players.length} players`)),
    h("div", { class: "card stack" },
      h("h2", { style: { margin: 0 } }, resuming ? `Welcome back! Round ${st.round + 1} of ${rounds()}` : "How to play"),
      h("div", { class: "small muted stack", style: { gap: ".35rem" } },
        h("div", null, "📱 Pass the phone. Each player holds the card to see the secret word, then passes it on."),
        h("div", null, nImp > 1 ? `🕵️ ${nImp} players are imposters: they don't get the word (and don't know each other).` : "🕵️ One player is the imposter: they don't get the word."),
        session.settings.hint && h("div", null, "🏷️ The imposter sees the category, to help them bluff."),
        h("div", null, "🗣️ Going around, everyone says ONE word about the secret. Not too obvious, or the imposter will figure it out!"),
        h("div", null, "🗳️ Discuss and vote out who you think is faking it."))),
    h("div", { class: "card stack" },
      h("b", null, "Points each round"),
      h("div", { class: "small muted stack", style: { gap: ".3rem" } },
        h("div", null, h("span", { class: "pts" }, `+${PTS.escaped}`), " imposter who isn't caught"),
        h("div", null, h("span", { class: "pts" }, `+${PTS.guessed}`), " caught imposter who then guesses the word"),
        h("div", null, h("span", { class: "pts" }, `+${PTS.crew}`), " every crew member, for each imposter caught (who misses the word)"))),
    resuming && standingsList(),
    h("button", { class: "btn primary xl block", onclick: () => {
      unlockAudio();
      if (!round) newRound();
      handoffScreen(0);
    } }, resuming ? "▶ Continue" : "▶ Start"))));
}

function handoffScreen(i) {
  if (i >= round.order.length) return cluesScreen();
  const pid = round.order[i];
  mount(root, h("div", { class: "screen" }, topBar(),
    h("div", { class: "screen centered" },
      h("div", { class: "muted" }, i === 0 ? "Everyone looks at their card in turn. Pass the phone to" : "Pass the phone to"),
      h("div", { class: "hand-emoji" }, pEmoji(pid)),
      h("div", { class: "hand-name" }, pName(pid)),
      h("button", { class: "btn primary xl", style: { minWidth: "60%" }, onclick: () => secretScreen(i) }, `I'm ${pName(pid)}`),
      h("div", { class: "small muted" }, `${i} of ${round.order.length} have looked`))));
}

function secretScreen(i) {
  const pid = round.order[i];
  const isImp = round.imposters.includes(pid);
  let seen = false;
  const done = h("button", { class: "btn primary xl block", disabled: true, onclick: () => handoffScreen(i + 1) },
    i + 1 >= round.order.length ? "Done: everyone has looked" : "Done: pass the phone on");
  const card = h("div", { class: "secret" });
  const closed = () => mount(card, h("div", { class: "big" }, "👆"), h("div", { class: "hold" }, "Press & hold to see your card"), h("div", { class: "tiny muted" }, "Make sure nobody else is looking"));
  const open = () => {
    card.classList.add("open");
    card.classList.toggle("imp", isImp);
    if (isImp) {
      mount(card, h("div", { class: "big" }, "🕵️"), h("div", { class: "role" }, "You're the IMPOSTER"),
        session.settings.hint ? h("div", { class: "cat" }, `Category: ${round.word.emoji} ${round.word.deck}`) : h("div", { class: "cat" }, "No hint: listen carefully!"),
        nImp > 1 && h("div", { class: "tiny muted" }, `There are ${nImp} imposters`));
    } else {
      mount(card, h("div", { class: "cat" }, `${round.word.emoji} ${round.word.deck}`), h("div", { class: "word" }, round.word.text), h("div", { class: "tiny muted" }, "Remember it, then let go"));
    }
    if (!seen) { seen = true; sfx.reveal(); }
  };
  const close = () => { card.classList.remove("open", "imp"); closed(); if (seen) done.disabled = false; };
  card.addEventListener("pointerdown", (e) => { e.preventDefault(); open(); });
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) card.addEventListener(ev, close);
  card.addEventListener("contextmenu", (e) => e.preventDefault());
  closed();
  mount(root, h("div", { class: "screen" }, topBar(),
    h("div", { class: "screen centered" },
      h("div", { class: "row", style: { fontSize: "1.2rem", fontWeight: 800 } }, pEmoji(pid), " ", pName(pid)),
      card, h("div", { style: { width: "100%", maxWidth: "420px" } }, done))));
}

let discussionTimer = null;
function cluesScreen() {
  const secs = Number(session.settings.discussion) || 0;
  clearInterval(discussionTimer);
  let left = secs;
  const timerEl = h("div", { class: "timer-big" }, fmt(left));
  function fmt(s) { return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }
  mount(root, h("div", { class: "screen" }, topBar(), h("div", { class: "screen centered" },
    h("div", { class: "muted" }, "Everyone has seen their card"),
    h("h2", { style: { margin: 0 } }, "🗣️ One word each, going around, starting with"),
    h("div", { class: "hand-name" }, pEmoji(round.starter), " ", pName(round.starter)),
    h("div", { class: "small muted", style: { maxWidth: "420px" } }, "Then discuss: who's bluffing? You can do a second lap of clues if you're unsure."),
    secs > 0 && timerEl,
    h("button", { class: "btn primary xl", style: { minWidth: "60%" }, onclick: () => { clearInterval(discussionTimer); voteScreen(); } }, "🗳️ Time to vote"))));
  if (secs > 0) {
    discussionTimer = setInterval(() => {
      left--;
      timerEl.textContent = fmt(Math.max(0, left));
      timerEl.classList.toggle("low", left <= 15);
      if (left <= 5 && left > 0) beep(1200, 0.04);
      if (left <= 0) { clearInterval(discussionTimer); sfx.end(); timerEl.textContent = "Vote!"; }
    }, 1000);
  }
}

function voteScreen() {
  const picked = new Set();
  const grid = h("div", { class: "vote-grid" });
  const go = h("button", { class: "btn primary xl block", disabled: true, onclick: () => verdictScreen([...picked]) });
  const draw = () => {
    mount(grid, players.map((p) => h("button", { class: `vote ${picked.has(p.player_id) ? "on" : ""}`, onclick: () => {
      if (picked.has(p.player_id)) picked.delete(p.player_id);
      else { if (picked.size >= nImp) picked.delete([...picked][0]); picked.add(p.player_id); }
      draw();
    } }, h("span", { class: "e" }, p.emoji), p.name)));
    go.disabled = picked.size !== nImp;
    go.textContent = picked.size === nImp ? "🔍 Reveal" : `Pick ${nImp - picked.size} more`;
  };
  draw();
  mount(root, h("div", { class: "screen" }, h("div", { class: "wrap" }, topBar(),
    h("div", { class: "center" }, h("h2", { style: { margin: ".5rem 0 .25rem" } }, "🗳️ Who's the imposter?"),
      h("div", { class: "small muted" }, nImp > 1 ? `Agree on ${nImp} players (majority vote), then tap them.` : "Agree on one player (majority vote), then tap them.")),
    grid, go)));
}

function verdictScreen(accused) {
  const caught = round.imposters.filter((id) => accused.includes(id));
  const escaped = round.imposters.filter((id) => !accused.includes(id));
  const guessed = new Map(); // caught imposter -> true/false (did they guess the word)
  const body = h("div", { class: "wrap" });

  const impNames = round.imposters.map((id) => `${pEmoji(id)} ${pName(id)}`).join(" & ");
  function draw() {
    const pending = caught.filter((id) => !guessed.has(id));
    const verdict = caught.length === 0
      ? h("div", { class: "verdict bad" }, nImp > 1 ? "The imposters got away! 😈" : "The imposter got away! 😈")
      : escaped.length
        ? h("div", { class: "verdict" }, "Half right! 🤏")
        : h("div", { class: "verdict good" }, nImp > 1 ? "Both imposters caught! 🎉" : "Imposter caught! 🎉");
    mount(body, topBar(),
      h("div", { class: "center stack", style: { gap: ".5rem" } },
        h("div", { class: "muted" }, nImp > 1 ? "The imposters were" : "The imposter was"),
        h("div", { class: "hand-name" }, impNames),
        verdict),
      pending.length
        ? h("div", { class: "card stack center" },
            h("b", null, `${pEmoji(pending[0])} ${pName(pending[0])}, last chance: what was the word?`),
            h("div", { class: "small muted" }, "Say it out loud, then reveal."),
            h("div", { class: "row", style: { justifyContent: "center" } },
              h("button", { class: "btn good", onclick: () => { guessed.set(pending[0], true); draw(); } }, "✓ Guessed it"),
              h("button", { class: "btn danger", onclick: () => { guessed.set(pending[0], false); draw(); } }, "✗ Wrong")))
        : finishRound());
  }

  function finishRound() {
    const deltas = {};
    const add = (id, n) => { if (n) { deltas[id] = (deltas[id] || 0) + n; } };
    for (const id of escaped) add(id, PTS.escaped);
    for (const id of caught) {
      if (guessed.get(id)) add(id, PTS.guessed);
      else for (const p of players) if (!round.imposters.includes(p.player_id)) add(p.player_id, PTS.crew);
    }
    const allCaught = escaped.length === 0;
    if (allCaught && [...guessed.values()].every((g) => !g)) sfx.win(); else sfx.lose();
    return h("div", { class: "stack" },
      h("div", { class: "card center" }, h("div", { class: "small muted" }, "The word was"),
        h("div", { style: { fontSize: "2rem", fontWeight: 900 } }, round.word.text),
        h("div", { class: "small muted" }, `${round.word.emoji} ${round.word.deck}`)),
      standingsList(deltas),
      h("button", { class: "btn primary xl block", onclick: async (e) => {
        e.currentTarget.disabled = true;
        for (const [id, n] of Object.entries(deltas)) st.scores[id] = (st.scores[id] || 0) + n;
        st.history.push({
          word: round.word.text, imposters: round.imposters, accused, caught,
          guessed: Object.fromEntries(guessed), points: deltas,
        });
        st.plays.push({ word_id: round.word.id, result: allCaught ? "correct" : "pass" });
        st.usedIds.push(round.word.id);
        st.lastImposters = round.imposters;
        st.round++;
        round = null;
        await save();
        if (st.round >= rounds()) finalScreen();
        else { newRound(); handoffScreen(0); }
      } }, st.round + 1 >= rounds() ? "🏁 Final scores" : "Next round ▶"));
  }

  mount(root, h("div", { class: "screen" }, body));
  draw();
}

function finalScreen() {
  round = null;
  const list = standings();
  const escapes = st.history.filter((r) => r.caught.length < r.imposters.length).length;
  const summary = `${st.history.length} rounds · imposters escaped ${escapes} time${escapes === 1 ? "" : "s"}`;
  mount(root, h("div", { class: "screen" }, h("div", { class: "wrap" },
    h("div", { class: "center" }, h("div", { style: { fontSize: "3.5rem" } }, "🏁"), h("h1", null, "Game over!"), h("div", { class: "muted" }, summary)),
    list[0] && h("div", { class: "center", style: { fontSize: "1.4rem", fontWeight: 800 } }, `🏆 ${list[0].emoji} ${list[0].name}`),
    standingsList(),
    h("button", { class: "btn primary xl block", onclick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await GC.submitResult({
          scores: players.map((p) => ({ player_id: p.player_id, score: st.scores[p.player_id] || 0 })),
          word_plays: st.plays,
          details: { summary, rounds: st.history },
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
  players = session.participants;
  byId = new Map(players.map((p) => [p.player_id, p]));
  // crew must outnumber imposters
  nImp = Math.max(1, Math.min(Number(session.settings.imposters) || 1, Math.floor((players.length - 1) / 2)));
  if (session.progress) Object.assign(st, session.progress);
  const all = await GC.getWords();
  if (!all.length) {
    mount(root, h("div", { class: "screen centered" }, h("h2", null, "No words in the selected decks"), h("button", { class: "btn", onclick: () => GC.quit() }, "Back")));
    return;
  }
  const used = new Set(st.usedIds);
  words = all.filter((w) => !used.has(w.id));
  if (!words.length) words = all;
  introScreen();
}

boot();
