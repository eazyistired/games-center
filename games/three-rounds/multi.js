// Three Rounds on everyone's phones. The clue-giver plays on their own phone (only that phone
// gets the word); everyone else follows live. The server engine keeps the clock and the rules.
import { h, mount, toast, modal, confirmDialog } from "/static/ui.js";
import { createSound, fit } from "/static/gamekit.js";

const GC = window.GC;
const root = document.getElementById("game");
let v = null;
let session = null;
let shownKey = null;
let deadline = null; // local ms timestamp of the buzzer
let startAt = null; // local ms timestamp when the clock starts (after the countdown)
let tick = null;
let timeUpSent = false;
let busy = false;
const sound = createSound(() => session?.settings?.sounds !== false);

const P = (id) => v.players.find((p) => p.id === id) || { name: "?", emoji: "🙂" };
const nm = (id) => `${P(id).emoji} ${P(id).name}`;
const pill = () => h("span", { class: "team-pill", style: { background: v.team_color } }, `Team ${v.team_name}`);

async function act(action) {
  if (busy) return;
  busy = true;
  try {
    const s = await GC.act(action);
    update(s); // don't wait for the live push: the next word shows instantly
  } catch (e) { toast(e.message, "bad"); }
  busy = false;
}

// ---------------------------------------------------------------- pieces
function standings() {
  const rows = v.scoreboard.slice().sort((a, b) => b.score - a.score);
  return h("div", { class: "card tight list" }, rows.map((r, i) => h("div", { class: "list-item" },
    h("span", { class: "muted", style: { width: "1.4rem" } }, i + 1),
    h("span", { class: "team-dot", style: { "--team": r.color } }),
    h("div", { class: "grow" }, h("b", null, r.name), " ", r.emoji, r.team === v.my_team ? h("span", { class: "tiny muted" }, " (you)") : null,
      h("div", { class: "rounds-mini" }, v.rounds.map((x, ri) => h("span", null, `${x.emoji} ${r.rounds[ri]}`)))),
    h("span", { class: "score" }, r.score))));
}

function roundCard() {
  const r = v.round_info;
  return h("div", { class: "card center stack", style: { gap: ".25rem" } },
    v.new_round && v.round > 0 ? h("span", { class: "round-chip", style: { alignSelf: "center" } }, `Round ${v.round + 1} of 3: same words!`) : h("span", { class: "small muted" }, `Round ${v.round + 1} of 3`),
    h("div", { style: { fontSize: "2.4rem" } }, r.emoji), h("b", { style: { fontSize: "1.3rem" } }, r.name), h("div", { class: "small muted" }, r.rule),
    h("div", { class: "tiny muted" }, `${v.hat} words in the hat`));
}

async function menu() {
  if (v.is_host) {
    const choice = await modal("👑 Host menu", h("p", { class: "muted" }, "Finishing now saves the scores so far."), [
      ["play", "paused"].includes(v.phase) && { label: "⏹ End this turn", value: "end" },
      { label: "👑 Make someone else host", value: "handover" },
      { label: "Finish now", value: "finish" },
      { label: "Close", class: "primary", value: null },
    ].filter(Boolean));
    if (choice === "end") act({ type: "end_turn" });
    if (choice === "finish" && await confirmDialog("Finish the game?", "Scores so far are saved.", "Finish")) act({ type: "finish" });
    if (choice === "handover") {
      const others = (session.lobby?.seats || []).filter((x) => x.joined && !x.mine);
      const id = await modal("👑 Make someone else host", h("p", { class: "muted" }, "They get the host controls; you keep playing."),
        [...others.map((x) => ({ label: `${x.emoji} ${x.name}`, value: x.player_id })), { label: "Cancel", class: "ghost", value: null }]);
      if (id != null) GC.makeHost(id).then(() => toast(`👑 ${nm(id)} is now the host`, "good")).catch((e) => toast(e.message, "bad"));
    }
    return;
  }
  const choice = await modal(nm(v.me), h("p", { class: "muted" }, "Need the host controls (e.g. the host left)? The host is asked first if their phone is active."), [
    { label: "👑 Become host", value: "host" }, { label: "Close", class: "primary", value: null }]);
  if (choice === "host") {
    toast("Asking the host…");
    const r = await GC.becomeHost().catch((e) => { toast(e.message, "bad"); return null; });
    if (r === "denied") toast("The host said no", "bad");
  }
}

const topBar = () => h("div", { class: "bar" },
  h("button", { class: "btn small ghost", onclick: menu }, v.is_host ? "👑 Host" : `${nm(v.me)} ▾`),
  h("span", { class: "badge" }, `${v.round_info.emoji} Round ${v.round + 1} · ${v.hat} left`));

// ---------------------------------------------------------------- phases
function readyPhase() {
  if (v.is_giver) {
    return [
      h("div", { class: "center stack", style: { gap: ".4rem" } }, pill(), h("h1", { style: { margin: 0 } }, "Your turn!"),
        h("div", { class: "muted" }, "Hold your phone so only you see it. Your team guesses."),
        v.carried ? h("span", { class: "badge gold", style: { alignSelf: "center" } }, `⏩ ${Math.round(v.turn_seconds)}s left over from last round`) : null),
      roundCard(),
      h("button", { class: "btn primary xl block", onclick: () => act({ type: "start" }) }, "▶ Start (3-2-1)"),
    ];
  }
  const mine = v.my_team === v.team;
  return [
    h("div", { class: "center stack", style: { gap: ".4rem" } }, pill(),
      h("div", { class: "hand-emoji" }, P(v.giver).emoji),
      h("h2", { style: { margin: 0 } }, `${P(v.giver).name} gives the clues`),
      h("div", { class: "muted" }, mine ? "Get ready to guess!" : `Team ${v.team_name}'s turn: no helping!`)),
    roundCard(),
    v.is_host && h("button", { class: "btn block", onclick: () => act({ type: "start" }) }, "Host: start the turn"),
  ];
}

function timerEl() {
  const el = h("div", { class: "timer-big", "data-timer": "1" }, "");
  return el;
}

function playPhase() {
  if (!v.is_giver) {
    const mine = v.my_team === v.team;
    return [
      h("div", { class: "center stack", style: { gap: ".4rem" } }, pill(),
        h("div", { style: { fontSize: "2.4rem" } }, v.round_info.emoji),
        h("h2", { style: { margin: 0 } }, mine ? `Guess! ${P(v.giver).name} is giving clues` : `Team ${v.team_name} is guessing`),
        h("div", { class: "small muted" }, v.round_info.rule)),
      h("div", { class: "card center stack", style: { gap: ".2rem" } }, timerEl(),
        h("div", { style: { fontSize: "1.3rem", fontWeight: 800, color: "#3ccf7f" } }, `✓ ${v.got}`),
        h("div", { class: "tiny muted" }, `${v.hat} words left in the hat`)),
      v.is_host && h("button", { class: "btn block", onclick: () => act({ type: "end_turn" }) }, "Host: end this turn"),
    ];
  }
  const word = h("div", { class: "word" }, v.word ? v.word.text : "");
  const skip = h("button", { class: "btn danger", disabled: v.skips_left === 0, onclick: () => { sound.skip(); act({ type: "skip" }); } },
    `Skip (${v.skips_left == null ? "∞" : v.skips_left})`);
  const play = h("div", { class: "play" },
    h("div", { class: "top" }, h("span", { style: { color: "#3ccf7f" } }, v.got), h("span", { class: "rule-hint" }, `${v.round_info.emoji} ${v.round_info.name}`), timerEl()),
    h("div", { class: "center" }, word, v.word && h("div", { class: "deck" }, `${v.word.emoji || ""} ${v.word.deck || ""}`)),
    h("div", null, h("div", { class: "controls" },
      skip,
      h("button", { class: "gk-pause-btn", "aria-label": "Pause", onclick: () => act({ type: "pause" }) }, "⏸"),
      h("button", { class: "btn good", onclick: () => { sound.correct(); act({ type: "got" }); } }, "✓ Got it"))));
  setTimeout(() => fit(word), 0);
  return [play];
}

function pausedPhase() {
  return [
    h("div", { class: "center stack", style: { gap: ".6rem", marginTop: "2rem" } },
      h("div", { class: "gk-overlay-title" }, "Paused"),
      h("div", { class: "muted" }, `${Math.ceil(v.left || 0)}s left · Team ${v.team_name} has ${v.got}`),
      (v.is_giver || v.is_host) && h("div", { class: "gk-overlay-actions" },
        h("button", { class: "btn primary xl", onclick: () => act({ type: "resume" }) }, "▶ Resume"),
        h("button", { class: "btn xl", onclick: () => act({ type: "end_turn" }) }, "⏹ End turn"))),
  ];
}

function reviewPhase() {
  const why = { pool: "Hat's empty! 🎩", time: "Time's up!", ended: "Turn ended" }[v.reason] || "";
  if (!(v.is_giver || v.is_host) || !v.items) {
    return [h("div", { class: "center stack", style: { gap: ".4rem", marginTop: "1rem" } }, pill(),
      h("h2", { style: { margin: 0 } }, why), h("div", { class: "muted" }, `${P(v.giver).name} is checking the words… (✓ ${v.got})`))];
  }
  const tag = (i) => i.correct ? "guessed" : i.kind === "skip" ? "skipped: out of the game" : "back in the hat";
  return [
    h("div", { class: "center" }, pill(), h("h2", { style: { margin: ".4rem 0 .2rem" } }, `${why} ✓ ${v.got}`), h("div", { class: "small muted" }, "Tap a word to fix a mistake.")),
    h("div", { class: "card tight" }, v.items.length ? v.items.map((it, i) => h("div", { class: `review-item ${it.correct ? "correct" : "miss"}`, onclick: () => act({ type: "toggle", index: i }) },
      h("div", { class: "t" }, it.text, h("div", { class: "tag" }, tag(it))), h("span", { class: "mark" }, it.correct ? "✓" : "✗"))) : h("p", { class: "muted center" }, "No words this turn.")),
    h("button", { class: "btn primary xl block", onclick: () => act({ type: "confirm" }) }, "Confirm"),
  ];
}

// ---------------------------------------------------------------- clock (local, from the server's numbers)
function runClock() {
  clearInterval(tick);
  if (v.phase !== "play") return;
  timeUpSent = false;
  let lastTick = null;
  const draw = () => {
    const now = Date.now();
    const els = document.querySelectorAll("[data-timer]");
    if (now < startAt) {
      els.forEach((el) => { el.textContent = `${Math.ceil((startAt - now) / 1000)}…`; el.classList.remove("low"); });
      return;
    }
    const left = Math.max(0, Math.ceil((deadline - now) / 1000));
    els.forEach((el) => { el.textContent = left; el.classList.toggle("low", left <= 10); });
    if (left <= 5 && left > 0 && left !== lastTick) { lastTick = left; sound.tick(); }
    if (left === 0 && v.is_giver && !timeUpSent) {
      timeUpSent = true;
      sound.end();
      GC.act({ type: "time_up" }).then(update).catch(() => { timeUpSent = false; });
    }
  };
  draw();
  tick = setInterval(draw, 200);
}

// ---------------------------------------------------------------- render
function render() {
  const key = `${v.phase}-${v.round}-${v.giver}-${v.word?.id ?? ""}-${v.got}-${v.hat}-${v.is_host}-${JSON.stringify(v.items || [])}`;
  if (key === shownKey) return;
  shownKey = key;
  const phases = { ready: readyPhase, play: playPhase, paused: pausedPhase, review: reviewPhase };
  const giverPlay = v.phase === "play" && v.is_giver;
  mount(root, giverPlay
    ? h("div", { class: "screen", style: { padding: 0 } }, ...phases.play())
    : h("div", { class: "screen" }, h("div", { class: "wrap" }, topBar(), ...phases[v.phase](), standings())));
  runClock();
}

function update(s) {
  session = s;
  if (s.status === "finished" || s.status === "abandoned") return GC.exit();
  if (s.status === "lobby" || !s.view) { location.href = `/#/sessions/${s.id}`; return; }
  if (v && !v.is_host && s.view.is_host) toast("👑 You're now the host", "good");
  const prev = v;
  v = s.view;
  if (v.phase === "play" && v.ends_in != null) {
    deadline = Date.now() + v.ends_in * 1000;
    startAt = Date.now() + (v.starts_in || 0) * 1000;
  }
  if (prev && prev.phase !== v.phase) {
    if (v.phase === "play") sound.count();
    if (v.phase === "ready" && v.is_giver) try { navigator.vibrate?.(200); } catch { /* ignore */ }
  }
  render();
}

export function runMulti() {
  mount(root, h("div", { class: "screen centered" }, h("div", { class: "spinner" })));
  document.addEventListener("pointerdown", () => sound.unlock(), { once: true });
  GC.connect(update);
}
