// Heads Up - one phone, passed around. Tilt down = correct, tilt up = pass.
import { h, mount, toast, confirmDialog, modal } from "/static/ui.js";

const GC = window.GC;
const root = document.getElementById("game");

const TILT_KEY = "gc.headsup.tiltSign";
const TRIGGER = 6.5; // m/s² along the screen normal (~40°)
const NEUTRAL = 3.5;
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

// ------------------------------------------------------------------ motion
const motion = { z: 0, has: false, sign: Number(ls.get(TILT_KEY)) || 1, listener: null };
function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.z === null) return;
  motion.has = true;
  motion.z = motion.z * 0.6 + a.z * 0.4; // low-pass
  motion.listener?.(motion.z * motion.sign);
}
async function enableMotion() {
  if (!session.settings.tilt) return false;
  try {
    if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
      const r = await DeviceMotionEvent.requestPermission();
      if (r !== "granted") { toast("Motion access denied: use the tap buttons", "bad"); return false; }
    }
  } catch {
    toast("Tilt needs HTTPS: use the tap buttons", "bad");
    return false;
  }
  window.removeEventListener("devicemotion", onMotion);
  window.addEventListener("devicemotion", onMotion);
  return true;
}

let releaseWake = null;
async function goFullscreen() {
  try {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    }
  } catch { /* iOS: not supported */ }
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

function sizeClass(text) {
  const longest = Math.max(...text.split(" ").map((w) => w.length));
  if (text.length <= 9 && longest <= 9) return "xl";
  if (text.length <= 16 && longest <= 12) return "l";
  if (text.length <= 26) return "m";
  return "s";
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
  const calibrated = ls.get(TILT_KEY) !== null;
  mount(root, h("div", { class: "screen" }, h("div", { class: "wrap" },
    h("div", { class: "bar" },
      h("button", { class: "back", onclick: () => (resuming ? menu() : GC.quit()) }, "‹"),
      h("b", null, "🙆 Heads Up"),
      h("span", { class: "badge" }, session.mode === "teams" ? "Teams" : "Solo")),
    h("div", { class: "card stack" },
      h("h2", { style: { margin: 0 } }, resuming ? `Welcome back! Turn ${st.turnIdx + 1} of ${turns.length}` : "How to play"),
      h("div", { class: "small muted stack", style: { gap: ".35rem" } },
        h("div", null, "📱 The guesser holds the phone on their forehead, screen facing out."),
        h("div", null, "🗣️ Everyone else gives clues (no saying the word!)."),
        tiltOn ? h("div", null, "⬇️ Tilt ", h("b", null, "down"), " = got it  ·  ⬆️ Tilt ", h("b", null, "up"), " = pass") : h("div", null, "👆 Tap right = got it · tap left = pass"),
        h("div", null, `⏱️ ${session.settings.round_seconds}s per turn · ${turns.length} turns · ${words.length} words`),
        session.mode === "teams" && h("div", null, "👥 Teammates give the clues; the team gets the points."))),
    tiltOn && h("div", { class: "card row between" },
      h("div", null, h("b", null, "Tilt test"), h("div", { class: "small muted" }, calibrated ? "Done on this phone ✓" : "Recommended once per phone")),
      h("button", { class: `btn small ${calibrated ? "" : "primary"}`, onclick: calibrateScreen }, calibrated ? "Redo" : "Test tilt")),
    standingsList(),
    h("button", { class: "btn primary xl block", onclick: async () => {
      unlockAudio();
      await enableMotion();
      await goFullscreen();
      handoffScreen();
    } }, resuming ? "▶ Continue" : "▶ Start"))));
}

async function calibrateScreen() {
  unlockAudio();
  if (!(await enableMotion())) return;
  const status = h("div", { class: "muted" }, "Waiting for the sensor…");
  mount(root, h("div", { class: "screen centered" },
    h("div", { class: "calib" }, "🙇"),
    h("h2", null, "Phone on your forehead, screen out, then nod DOWN"),
    status,
    h("button", { class: "btn ghost", onclick: () => { motion.listener = null; introScreen(); } }, "Cancel")));
  let neutralSeen = false;
  setTimeout(() => { if (!motion.has) status.textContent = "No motion sensor found: tilt won't work here, use taps."; }, 2500);
  motion.listener = (nz) => {
    const raw = nz * motion.sign;
    status.textContent = neutralSeen ? "Now nod down…" : "Hold it upright on your forehead…";
    if (Math.abs(raw) < NEUTRAL) neutralSeen = true;
    if (neutralSeen && Math.abs(raw) > TRIGGER + 1) {
      motion.sign = raw < 0 ? 1 : -1;
      ls.set(TILT_KEY, String(motion.sign));
      motion.listener = null;
      sfx.correct();
      toast("Tilt calibrated ✓", "good");
      introScreen();
    }
  };
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
  const endAt = Date.now() + seconds * 1000;
  const shown = []; // [{word, result}]
  let current = nextWord();
  let busy = false;
  let armed = false;
  let lastTick = null;
  let finished = false;
  const tilt = session.settings.tilt && motion.has;

  const wordEl = h("div", { class: `word ${sizeClass(current.text)}` }, current.text);
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
    h("div", { class: "progress" }, progress));
  mount(root, play);

  function act(result) {
    if (busy || finished) return;
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
      wordEl.className = `word ${sizeClass(current.text)}`;
      wordEl.textContent = current.text;
      deckEl.textContent = `${current.emoji} ${current.deck}`;
      mount(center, wordEl);
      busy = false;
    }, FEEDBACK_MS);
  }

  motion.listener = (nz) => {
    if (!session.settings.tilt) return;
    if (!armed) { if (Math.abs(nz) < NEUTRAL && !busy) armed = true; return; }
    if (nz < -TRIGGER) act("correct");
    else if (nz > TRIGGER) act("pass");
  };

  function frame() {
    if (finished) return;
    const left = Math.max(0, endAt - Date.now());
    const secs = Math.ceil(left / 1000);
    timerEl.textContent = secs;
    timerEl.classList.toggle("low", secs <= 10);
    progress.style.width = `${(left / (seconds * 1000)) * 100}%`;
    if (secs <= 5 && secs !== lastTick && secs > 0) { lastTick = secs; sfx.tick(); }
    if (left <= 0) return timeUp();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  function timeUp() {
    finished = true;
    motion.listener = null;
    if (!busy) shown.push({ word: current, result: "pass", timeout: true });
    sfx.end();
    play.className = "play timeup";
    mount(play, h("div", { class: "feedback" }, "Time's up!"));
    setTimeout(() => reviewScreen(turn, shown), 1300);
  }
}

function reviewScreen(turn, shown) {
  const list = h("div", { class: "card tight" });
  const total = h("b");
  const draw = () => {
    total.textContent = shown.filter((s) => s.result === "correct").length;
    mount(list, shown.length ? shown.map((s) => h("div", { class: `review-item ${s.result}`, onclick: () => { s.result = s.result === "correct" ? "pass" : "correct"; draw(); } },
      h("span", { class: "t" }, s.word.text, s.timeout && h("span", { class: "tiny muted" }, "  ⏱ time ran out")),
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
