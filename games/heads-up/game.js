// Heads Up - one phone, passed around. Tilt down = correct, tilt up = pass.
import { h, mount, toast, confirmDialog, modal, switchField } from "/static/ui.js";

const GC = window.GC;
const root = document.getElementById("game");

const FLIP_KEY = "gc.headsup.flipTilt";
// "face" = how much the screen points at the ceiling: +1 face up, 0 upright on the forehead, -1 face down
const DOWN = -0.6; // tilt down (screen to floor) = correct
const UP = 0.6; // tilt up (screen to ceiling) = pass
const NEUTRAL = 0.35; // must come back to upright before the next answer
const FEEDBACK_MS = 650;

const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

// ------------------------------------------------------------------ state
let session, words = [], players;
const st = {
  turnIdx: 0,
  scores: {}, // solo: {player_id: n}, teams: {team_idx: n}
  perPlayer: {}, // {player_id: correct}
  plays: [], // [{word_id, result}]
  usedIds: [],
  turnLog: [], // [{player_id, team, correct, passed}]
};
let turns = [];
let wordPos = 0;

// ------------------------------------------------------------------ audio
let actx = null;
function beep(freq, dur = 0.12, type = "sine", gain = 0.18, when = 0) {
  if (!session?.settings.sounds || !actx) return;
  const t = actx.currentTime + when;
  const o = actx.createOscillator();
  const g = actx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(actx.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}
const sfx = {
  correct() { beep(660, 0.1, "triangle"); beep(990, 0.18, "triangle", 0.18, 0.09); vibrate(60); },
  pass() { beep(320, 0.12, "square", 0.1); beep(220, 0.2, "square", 0.1, 0.1); vibrate([30, 40, 30]); },
  tick() { beep(1200, 0.04, "sine", 0.12); },
  count() { beep(520, 0.12, "sine", 0.2); },
  go() { beep(880, 0.25, "sine", 0.22); },
  end() { beep(180, 0.6, "sawtooth", 0.15); vibrate(400); },
};
function vibrate(p) { try { navigator.vibrate?.(p); } catch { /* ignore */ } }
function unlockAudio() {
  try {
    actx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === "suspended") actx.resume();
  } catch { /* no audio */ }
}

// ------------------------------------------------------------------ tilt
// Primary source: deviceorientation -> face = cos(beta) * cos(gamma) (same sign on iOS & Android)
// Fallback: devicemotion gravity z / 9.81 (iOS reports it inverted)
const isIOS = /iP(hone|ad|od)/.test(navigator.platform) || (navigator.userAgent.includes("Mac") && "ontouchend" in document);
const motion = { face: 0, src: null, has: false, last: 0, flip: ls.get(FLIP_KEY) === "1", listener: null, listening: false };

function feed(v, from) {
  if (!Number.isFinite(v)) return;
  if (motion.src === "ori" && from === "mot") return; // prefer orientation once it's flowing
  motion.src = from;
  motion.has = true;
  motion.last = Date.now();
  if (motion.flip) v = -v;
  motion.face = motion.face * 0.5 + v * 0.5;
  motion.listener?.(motion.face);
}
function onOri(e) {
  if (e.beta == null || e.gamma == null) return;
  const r = Math.PI / 180;
  feed(Math.cos(e.beta * r) * Math.cos(e.gamma * r), "ori");
}
function onMot(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.z == null) return;
  feed((isIOS ? -a.z : a.z) / 9.81, "mot");
}

/** MUST be called synchronously inside a tap handler (iOS shows the permission prompt then). */
function enableMotion() {
  const asks = [];
  try {
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function")
      asks.push(DeviceOrientationEvent.requestPermission().catch(() => "denied"));
  } catch { /* ignore */ }
  try {
    if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function")
      asks.push(DeviceMotionEvent.requestPermission().catch(() => "denied"));
  } catch { /* ignore */ }
  return Promise.all(asks).then((r) => {
    if (!motion.listening) {
      window.addEventListener("deviceorientation", onOri, true);
      window.addEventListener("devicemotion", onMot, true);
      motion.listening = true;
    }
    return !r.includes("denied");
  });
}

function setFlip(v) {
  motion.flip = v;
  ls.set(FLIP_KEY, v ? "1" : "0");
}

let releaseWake = null;
async function goFullscreen() {
  try {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    }
  } catch { /* iOS: not supported */ }
  try { await screen.orientation?.lock?.("landscape"); } catch { /* not supported */ }
  releaseWake ||= await GC.keepAwake();
}

// ------------------------------------------------------------------ helpers
const pName = (pid) => players.get(pid)?.name || "?";
const pEmoji = (pid) => players.get(pid)?.emoji || "🙂";
const scoreKey = (turn) => (session.mode === "teams" ? turn.team : turn.player_id);

function buildTurns() {
  const rounds = Number(session.settings.rounds) || 1;
  const out = [];
  if (session.mode === "teams") {
    const maxSize = Math.max(...session.teams.map((t) => t.player_ids.length));
    for (let r = 0; r < rounds; r++)
      for (let m = 0; m < maxSize; m++)
        for (const t of session.teams) out.push({ team: t.idx, player_id: t.player_ids[(m + r * maxSize) % t.player_ids.length] });
  } else {
    for (let r = 0; r < rounds; r++) for (const p of session.participants) out.push({ player_id: p.player_id });
  }
  return out;
}

function nextWord() {
  if (wordPos >= words.length) { // ran out: reuse, shuffled
    words = words.slice().sort(() => Math.random() - 0.5);
    wordPos = 0;
  }
  return words[wordPos++];
}

/** Shrink the word until it fits the screen (long movie titles!). */
function fit(el) {
  el.style.fontSize = "";
  let size = parseFloat(getComputedStyle(el).fontSize);
  while ((el.scrollHeight > innerHeight * 0.62 || el.scrollWidth > innerWidth * 0.95) && size > 22) {
    size -= 4;
    el.style.fontSize = `${size}px`;
  }
}

function save() {
  return GC.saveProgress({ ...st }).catch(() => toast("Couldn't save progress (offline?)", "bad"));
}

function standings() {
  if (session.mode === "teams") {
    return session.teams.map((t) => ({ key: t.idx, name: t.name, emoji: t.player_ids.map(pEmoji).join(""), color: t.color, score: st.scores[t.idx] || 0 }))
      .sort((a, b) => b.score - a.score);
  }
  return session.participants.map((p) => ({ key: p.player_id, name: p.name, emoji: p.emoji, score: st.scores[p.player_id] || 0 }))
    .sort((a, b) => b.score - a.score);
}

function standingsList() {
  return h("div", { class: "card tight list standings" }, standings().map((s, i) => h("div", { class: "list-item" },
    h("span", { class: "muted", style: { width: "1.5rem" } }, i + 1),
    h("span", { style: { fontSize: "1.3rem" } }, s.emoji),
    h("span", { class: "grow", style: { fontWeight: 650 } }, s.color && h("span", { class: "team-dot", style: { "--team": s.color } }), s.name),
    h("span", { class: "score" }, s.score))));
}

async function menu() {
  const choice = await modal("Game menu", h("p", { class: "muted" }, "Finishing now saves the scores of the turns played so far."), [
    { label: "Quit (don't save)", class: "danger", value: "quit" },
    { label: "Finish now", class: "", value: "finish" },
    { label: "Keep playing", class: "primary", value: null },
  ]);
  if (choice === "finish") return finalScreen();
  if (choice === "quit" && await confirmDialog("Quit game?", "This game won't count for the leaderboards.", "Quit", true)) GC.quit();
}

// ------------------------------------------------------------------ screens
function introScreen() {
  const resuming = st.turnIdx > 0;
  const tiltOn = session.settings.tilt;
  mount(root, h("div", { class: "screen" }, h("div", { class: "wrap" },
    h("div", { class: "bar" },
      h("button", { class: "back", onclick: () => (resuming ? menu() : GC.quit()) }, "‹"),
      h("div", { class: "logo" }, "HEADS UP"),
      h("span", { class: "badge" }, session.mode === "teams" ? "Teams" : "Solo")),
    h("div", { class: "card stack" },
      h("h2", { style: { margin: 0 } }, resuming ? `Welcome back! Turn ${st.turnIdx + 1} of ${turns.length}` : "How to play"),
      h("div", { class: "small muted stack", style: { gap: ".35rem" } },
        h("div", null, "📱 The guesser holds the phone on their forehead, screen facing out."),
        h("div", null, "🗣️ Everyone else gives clues (no saying the word!)."),
        tiltOn ? h("div", null, "⬇️ Tilt ", h("b", null, "down"), " = got it  ·  ⬆️ Tilt ", h("b", null, "up"), " = pass") : h("div", null, "👆 Tap right = got it · tap left = pass"),
        h("div", null, "🔄 Landscape works best on the forehead."),
        h("div", null, `⏱️ ${session.settings.round_seconds}s per turn · ${turns.length} turns · ${words.length} words`),
        session.mode === "teams" && h("div", null, "👥 Teammates give the clues; the team gets the points."))),
    tiltOn && h("div", { class: "card stack" },
      h("div", { class: "row between" },
        h("div", null, h("b", null, "Tilt sensor"), h("div", { class: "small muted" }, "Check it once per phone")),
        h("button", { class: "btn small", onclick: () => { const p = enableMotion(); testScreen(p); } }, "Test tilt")),
      switchField("Flip tilt direction", motion.flip, setFlip, "Turn on if down/up are swapped on this phone")),
    standingsList(),
    h("button", { class: "btn primary xl block", onclick: () => {
      const granted = tiltOn ? enableMotion() : Promise.resolve(true); // synchronous in the tap (iOS)
      unlockAudio();
      goFullscreen();
      granted.then((ok) => { if (!ok) toast("Motion access denied: use the tap controls", "bad"); });
      handoffScreen();
    } }, resuming ? "▶ Continue" : "▶ Start"))));
}

function testScreen(permission) {
  const state = h("div", { class: "tstate" }, "…");
  const dot = h("div", { class: "tdot" });
  const val = h("div", { class: "tval" }, "waiting for sensor…");
  const msg = h("p", { class: "muted", style: { maxWidth: "440px" } },
    "Hold the phone sideways on your forehead, screen facing out. Tilt down: it should say DOWN. Tilt up: UP. If they're swapped, turn on Flip.");
  const back = () => { motion.listener = null; introScreen(); };
  mount(root, h("div", { class: "screen centered" },
    state, h("div", { class: "tbar" }, dot), val, msg,
    h("div", { style: { width: "100%", maxWidth: "320px" } }, switchField("Flip tilt direction", motion.flip, setFlip)),
    h("button", { class: "btn", style: { minWidth: "200px" }, onclick: back }, "Back")));
  const started = Date.now();
  motion.listener = (face) => {
    dot.style.left = `calc(${50 - face * 50}% - 8px)`;
    val.textContent = `sensor: ${motion.src === "ori" ? "orientation" : "motion"} · value ${face.toFixed(2)}`;
    if (face < DOWN) { state.textContent = "DOWN ✅"; state.style.color = "#3ccf7f"; }
    else if (face > UP) { state.textContent = "UP ⏭️"; state.style.color = "#ef6a50"; }
    else { state.textContent = "LEVEL"; state.style.color = ""; }
  };
  permission.then((ok) => setTimeout(() => {
    if (motion.last >= started || !root.contains(state)) return;
    state.textContent = "No sensor data";
    state.style.color = "var(--accent)";
    val.textContent = ok ? "the browser isn't sending motion events" : "motion permission was denied";
    msg.textContent = isIOS
      ? "On iPhone, Safari only gives motion data to https:// pages with a trusted certificate. If you denied the prompt, close the tab and reopen it. Tap controls work meanwhile."
      : "Check Chrome ▸ Settings ▸ Site settings ▸ Motion sensors is allowed, and that the page is opened over https://. Tap controls work meanwhile.";
  }, 1500));
}

function handoffScreen() {
  if (st.turnIdx >= turns.length) return finalScreen();
  const turn = turns[st.turnIdx];
  const team = session.mode === "teams" ? session.teams.find((t) => t.idx === turn.team) : null;
  mount(root, h("div", { class: "screen centered", style: team ? { background: `linear-gradient(180deg, ${team.color}44, var(--bg) 70%)` } : {} },
    h("div", { style: { position: "absolute", top: "calc(12px + env(safe-area-inset-top))", left: "16px", right: "16px", display: "flex", justifyContent: "space-between" } },
      h("button", { class: "btn small ghost", onclick: menu }, "☰ Menu"),
      h("span", { class: "badge" }, `Turn ${st.turnIdx + 1} / ${turns.length}`)),
    team && h("span", { class: "team-pill", style: { background: team.color } }, `Team ${team.name}`),
    h("div", { class: "muted" }, "Pass the phone to"),
    h("div", { class: "hand-emoji" }, pEmoji(turn.player_id)),
    h("div", { class: "hand-name" }, pName(turn.player_id)),
    h("button", { class: "btn primary xl", style: { minWidth: "60%" }, onclick: () => { unlockAudio(); countdownScreen(turn); } }, "I'm ready"),
    h("div", { style: { width: "100%", maxWidth: "480px", marginTop: ".5rem" } }, standingsList())));
}

function countdownScreen(turn) {
  let n = 3;
  const num = h("div", { class: "countdown" }, n);
  mount(root, h("div", { class: "screen centered" },
    h("div", { class: "muted", style: { fontSize: "1.2rem" } }, "Phone on your forehead!"),
    num));
  sfx.count();
  const iv = setInterval(() => {
    n--;
    if (n <= 0) { clearInterval(iv); sfx.go(); playScreen(turn); return; }
    num.textContent = n;
    num.style.animation = "none"; void num.offsetWidth; num.style.animation = "";
    sfx.count();
  }, 900);
}

function playScreen(turn) {
  const seconds = Number(session.settings.round_seconds) || 60;
  let endAt = Date.now() + seconds * 1000;
  let paused = false;
  let remaining = 0;
  const shown = []; // [{word, result}]
  let current = nextWord();
  let busy = false;
  let armed = false;
  let lastTick = null;
  let finished = false;
  const tilt = session.settings.tilt && motion.has;

  const wordEl = h("div", { class: "word" }, current.text);
  const deckEl = h("div", { class: "deck" }, `${current.emoji} ${current.deck}`);
  const timerEl = h("div", { class: "timer" }, seconds);
  const countEl = h("div", { class: "count" }, "0");
  const progress = h("div", { style: { width: "100%" } });
  const center = h("div", null, wordEl);
  const play = h("div", { class: `play ${tilt ? "" : "tap-mode"}` },
    deckEl, countEl, timerEl, center,
    h("div", { class: "taps" },
      h("button", { class: "btn", onclick: () => act("pass") }, "⬆ Pass"),
      h("button", { class: "btn good", onclick: () => act("correct") }, "Got it ⬇")),
    !tilt && h("div", { class: "tap-hint" }, h("span", null, "◀ tap: pass"), h("span", null, "tap: got it ▶")),
    h("button", { class: "pause-btn", "aria-label": "Pause", onclick: (e) => { e.stopPropagation(); pause(); } }, "⏸"),
    h("div", { class: "progress" }, progress));
  mount(root, play);
  fit(wordEl);

  // ---- pause menu: resume, or end this player's turn early (the game continues)
  function pause() {
    if (finished || paused) return;
    paused = true;
    armed = false;
    remaining = Math.max(0, endAt - Date.now());
    const secsLeft = Math.ceil(remaining / 1000);
    play.append(h("div", { class: "pause-overlay", onclick: (e) => e.stopPropagation() },
      h("div", { class: "pause-title" }, "Paused"),
      h("div", { class: "muted" }, `${pName(turn.player_id)} · ${secsLeft}s left · ${shown.filter((x) => x.result === "correct").length} correct`),
      h("div", { class: "pause-actions" },
        h("button", { class: "btn primary xl", onclick: resume }, "▶ Resume"),
        h("button", { class: "btn xl", onclick: () => endTurn("Turn ended") }, "⏹ End turn now"))));
  }
  function resume() {
    if (!paused) return;
    play.querySelector(".pause-overlay")?.remove();
    paused = false;
    endAt = Date.now() + remaining;
    lastTick = null;
    requestAnimationFrame(frame);
  }
  const onHidden = () => { if (document.visibilityState === "hidden") pause(); };
  document.addEventListener("visibilitychange", onHidden);

  function act(result) {
    if (busy || finished || paused) return;
    busy = true;
    armed = false;
    shown.push({ word: current, result });
    if (result === "correct") sfx.correct(); else sfx.pass();
    countEl.textContent = shown.filter((s) => s.result === "correct").length;
    play.classList.add(result);
    mount(center, h("div", { class: "feedback" }, result === "correct" ? "Correct!" : "Pass"));
    setTimeout(() => {
      if (finished) return;
      play.classList.remove(result);
      current = nextWord();
      wordEl.textContent = current.text;
      deckEl.textContent = `${current.emoji} ${current.deck}`;
      mount(center, wordEl);
      fit(wordEl);
      busy = false;
    }, FEEDBACK_MS);
  }

  motion.listener = (face) => {
    if (!session.settings.tilt || paused) return;
    if (!armed) { if (Math.abs(face) < NEUTRAL && !busy) armed = true; return; }
    if (face < DOWN) act("correct");
    else if (face > UP) act("pass");
  };

  function frame() {
    if (finished || paused) return;
    const left = Math.max(0, endAt - Date.now());
    const secs = Math.ceil(left / 1000);
    timerEl.textContent = secs;
    timerEl.classList.toggle("low", secs <= 10);
    progress.style.width = `${(left / (seconds * 1000)) * 100}%`;
    if (secs <= 5 && secs !== lastTick && secs > 0) { lastTick = secs; sfx.tick(); }
    if (left <= 0) return endTurn("Time's up!");
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  function endTurn(label) {
    if (finished) return;
    finished = true;
    paused = false;
    motion.listener = null;
    document.removeEventListener("visibilitychange", onHidden);
    // the word on screen when the turn ends is reviewable (it may have been guessed at the buzzer)
    if (!busy) shown.push({ word: current, result: "pass", timeout: true });
    sfx.end();
    play.className = "play timeup";
    mount(play, h("div", { class: "feedback" }, label));
    setTimeout(() => reviewScreen(turn, shown), 1100);
  }
}

function reviewScreen(turn, shown) {
  const list = h("div", { class: "card tight" });
  const total = h("b");
  const draw = () => {
    total.textContent = shown.filter((s) => s.result === "correct").length;
    mount(list, shown.length ? shown.map((s) => h("div", { class: `review-item ${s.result}`, onclick: () => { s.result = s.result === "correct" ? "pass" : "correct"; draw(); } },
      h("span", { class: "t" }, s.word.text, s.timeout && h("span", { class: "tiny muted" }, "  ⏱ on screen at the end")),
      h("span", { class: "mark" }, s.result === "correct" ? "✓" : "✗"))) : h("p", { class: "muted center" }, "No words this turn."));
  };
  draw();
  const team = session.mode === "teams" ? session.teams.find((t) => t.idx === turn.team) : null;
  mount(root, h("div", { class: "screen" }, h("div", { class: "wrap" },
    h("div", { class: "center" },
      h("div", { style: { fontSize: "3rem" } }, pEmoji(turn.player_id)),
      h("h2", { style: { margin: ".25rem 0" } }, pName(turn.player_id), " got ", total, team ? ` for ${team.name}` : ""),
      h("div", { class: "small muted" }, "Tap a word to fix a wrong tilt.")),
    list,
    h("button", { class: "btn primary xl block", onclick: async (e) => {
      e.currentTarget.disabled = true;
      const correct = shown.filter((s) => s.result === "correct").length;
      const key = scoreKey(turn);
      st.scores[key] = (st.scores[key] || 0) + correct;
      st.perPlayer[turn.player_id] = (st.perPlayer[turn.player_id] || 0) + correct;
      for (const s of shown) {
        st.plays.push({ word_id: s.word.id, result: s.result });
        st.usedIds.push(s.word.id);
      }
      st.turnLog.push({ player_id: turn.player_id, team: turn.team ?? null, correct, passed: shown.length - correct });
      st.turnIdx++;
      await save();
      handoffScreen();
    } }, st.turnIdx + 1 >= turns.length ? "Confirm & see final scores" : "Confirm & next player"))));
}

function finalScreen() {
  const list = standings();
  const best = Object.entries(st.perPlayer).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])[0];
  const totalCorrect = Object.values(st.perPlayer).reduce((a, b) => a + b, 0);
  mount(root, h("div", { class: "screen" }, h("div", { class: "wrap" },
    h("div", { class: "center" }, h("div", { style: { fontSize: "3.5rem" } }, "🏁"), h("h1", null, "Game over!"),
      h("div", { class: "muted" }, `${totalCorrect} words guessed`, best ? ` · best guesser: ${pEmoji(Number(best[0]))} ${pName(Number(best[0]))} (${best[1]})` : "")),
    h("div", { class: "center", style: { fontSize: "1.4rem", fontWeight: 800 } }, `🏆 ${list[0]?.emoji || ""} ${list[0]?.name || ""}`),
    standingsList(),
    h("button", { class: "btn primary xl block", onclick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      const scores = session.mode === "teams"
        ? session.teams.map((t) => ({ team: t.idx, score: st.scores[t.idx] || 0 }))
        : session.participants.map((p) => ({ player_id: p.player_id, score: st.scores[p.player_id] || 0 }));
      try {
        await GC.submitResult({
          scores,
          word_plays: st.plays,
          details: {
            summary: `${totalCorrect} words guessed in ${st.turnLog.length} turns` + (best ? ` · best guesser ${pName(Number(best[0]))} (${best[1]})` : ""),
            per_player: st.perPlayer,
            turns: st.turnLog,
          },
        });
        releaseWake?.();
        if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
        GC.exit();
      } catch (err) {
        toast(err.message, "bad");
        btn.disabled = false;
      }
    } }, "💾 Save & see results"),
    h("button", { class: "btn ghost block", onclick: menu }, "Menu"))));
}

// ------------------------------------------------------------------ boot
async function boot() {
  mount(root, h("div", { class: "screen centered" }, h("div", { class: "spinner" })));
  try {
    session = await GC.getSession();
  } catch (e) {
    mount(root, h("div", { class: "screen centered" }, h("h2", null, "😵 " + e.message), h("a", { class: "btn", href: "/" }, "Home")));
    return;
  }
  if (session.status !== "active") return GC.exit();
  players = new Map(session.participants.map((p) => [p.player_id, p]));

  turns = buildTurns();
  if (session.progress) Object.assign(st, session.progress);
  const all = await GC.getWords();
  const used = new Set(st.usedIds);
  words = all.filter((w) => !used.has(w.id));
  if (!words.length) words = all;
  if (!all.length) {
    mount(root, h("div", { class: "screen centered" }, h("h2", null, "No words in the selected decks"), h("button", { class: "btn", onclick: () => GC.quit() }, "Back")));
    return;
  }
  introScreen();
}

boot();
