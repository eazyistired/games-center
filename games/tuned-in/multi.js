// Tuned In on everyone's phones. The server engine decides; this renders session.view.
import { h, mount, toast, modal, confirmDialog } from "/static/ui.js";
import { createSound } from "/static/gamekit.js";
import { dial, ends } from "/static/dial.js";

const GC = window.GC;
const root = document.getElementById("game");
let v = null;
let session = null;
let shownKey = null; // turn + phase currently on screen
let live = null; // the draggable dial while guessing
let dragging = false;
const sound = createSound(() => session?.settings?.sounds !== false);

const P = (id) => v.players.find((p) => p.id === id) || { name: "?", emoji: "🙂" };
const nm = (id) => `${P(id).emoji} ${P(id).name}`;
const team = (idx) => v.teams.find((t) => t.idx === idx);
const send = (action) => GC.act(action).catch((e) => toast(e.message, "bad"));
const pill = (t) => h("span", { class: "team-pill", style: { background: t.color } }, `Team ${t.name}`);

// ---------------------------------------------------------------- shared pieces
function standings() {
  const rows = v.scoreboard.slice().sort((a, b) => b.score - a.score);
  return h("div", { class: "card tight list" }, rows.map((r, i) => h("div", { class: "list-item" },
    h("span", { class: "muted", style: { width: "1.4rem" } }, i + 1),
    h("span", { class: "team-dot", style: { "--team": r.color } }),
    h("span", { class: "grow" }, h("b", null, r.name), " ", r.emoji, r.team === v.my_team ? h("span", { class: "tiny muted" }, " (you)") : null),
    h("span", { class: "score" }, r.score, v.deltas?.[r.team] && v.phase === "reveal" ? h("span", { class: "delta" }, `+${v.deltas[r.team]}`) : null,
      h("span", { class: "muted small" }, ` / ${v.play_to}`)))));
}

async function menu() {
  if (v.is_host) {
    const choice = await modal("👑 Host menu", h("p", { class: "muted" }, "Finishing now saves the scores so far."), [
      { label: "👑 Make someone else host", value: "handover" },
      { label: "Finish now", value: "finish" },
      { label: "Close", class: "primary", value: null },
    ]);
    if (choice === "finish" && await confirmDialog("Finish the game?", "Scores so far are saved.", "Finish")) send({ type: "finish" });
    if (choice === "handover") {
      const others = (session.lobby?.seats || []).filter((x) => x.joined && !x.mine);
      const id = await modal("👑 Make someone else host", h("p", { class: "muted" }, "They get the host controls; you keep playing."),
        [...others.map((x) => ({ label: `${x.emoji} ${x.name}`, value: x.player_id })), { label: "Cancel", class: "ghost", value: null }]);
      if (id != null) GC.makeHost(id).then(() => toast(`👑 ${nm(id)} is now the host`, "good")).catch((e) => toast(e.message, "bad"));
    }
  }
}

const topBar = () => h("div", { class: "bar" },
  v.is_host ? h("button", { class: "btn small ghost", onclick: menu }, "👑 Host") : h("span", { class: "badge" }, `👑 ${GC.hostName(session)}`),
  h("span", { class: "badge" }, `Turn ${v.turn} · play to ${v.play_to}`));

// ---------------------------------------------------------------- phases
function cluePhase() {
  const t = team(v.team);
  if (v.is_giver) {
    return [
      h("div", { class: "center" }, h("b", { class: "secret-warn" }, "🤫 Only you see this")),
      ends(v.card),
      dial({ target: v.target, needle: v.target }).el,
      h("div", { class: "card small" }, "Think of ONE clue that sits ", h("b", null, "right on the red zone"), ` between “${v.card[0]}” and “${v.card[1]}”. No numbers!`),
      h("div", { class: "row" },
        v.swaps_left > 0 && h("button", { class: "btn", onclick: () => send({ type: "swap" }) }, `🔄 Other card (${v.swaps_left})`),
        h("button", { class: "btn primary grow", onclick: () => send({ type: "clue_ready" }) }, "Got my clue")),
    ];
  }
  return [
    h("div", { class: "center stack", style: { gap: ".4rem", marginTop: "1rem" } },
      pill(t),
      h("div", { class: "hand-emoji" }, P(v.giver).emoji),
      h("h2", { style: { margin: 0 } }, `${P(v.giver).name} is thinking of a clue…`),
      h("div", { class: "muted" }, v.my_team === v.team ? "Get ready: your team guesses next!" : "Your team bets after they lock in.")),
  ];
}

function guessPhase() {
  const t = team(v.team);
  const d = dial({ needle: v.needle, draggable: v.can_move, onChange: v.can_move ? queueNeedle : null });
  live = d;
  const nudge = (dv) => h("button", { class: "btn small", onclick: () => d.set(d.value + dv) }, dv < 0 ? "◀" : "▶");
  return [
    h("div", { class: "center" }, pill(t),
      h("h2", { style: { margin: ".4rem 0 0" } }, v.is_giver ? "Say your clue out loud!" : `${P(v.giver).emoji} ${P(v.giver).name} gives the clue`),
      h("div", { class: "small muted" }, v.can_move ? "Drag the needle (everyone sees it move), then lock it in."
        : v.is_giver ? "Your team is turning the dial. No hints!" : `Team ${t.name} is turning the dial…`)),
    ends(v.card),
    d.el,
    v.can_move && h("div", { class: "nudge" }, nudge(-0.01), h("span", { class: "small muted", style: { alignSelf: "center" } }, "fine-tune"), nudge(0.01)),
    (v.can_move || v.is_host) && h("button", { class: "btn primary xl block", onclick: () => { flushNeedle(); send({ type: "lock" }); } }, "🔒 Lock it in"),
  ];
}

function betPhase() {
  const mine = v.bets[String(v.my_team)];
  const others = v.teams.filter((t) => t.idx !== v.team);
  return [
    h("div", { class: "center" }, h("h2", { style: { margin: ".25rem 0" } }, "🎲 Bets"),
      h("div", { class: "small muted" }, "Is the real target LEFT or RIGHT of the needle? +1 for a right guess (not on a bullseye).")),
    ends(v.card),
    dial({ needle: v.needle }).el,
    v.can_bet && h("div", { class: "row" },
      h("button", { class: `btn xl grow ${mine === "left" ? "primary" : ""}`, onclick: () => send({ type: "bet", side: "left" }) }, "◀ Left"),
      h("button", { class: `btn xl grow ${mine === "right" ? "primary" : ""}`, onclick: () => send({ type: "bet", side: "right" }) }, "Right ▶")),
    h("div", { class: "card tight list" }, others.map((t) => h("div", { class: "list-item" },
      h("span", { class: "team-dot", style: { "--team": t.color } }), h("span", { class: "grow" }, t.name),
      h("b", null, v.bets[String(t.idx)] ? (v.bets[String(t.idx)] === "left" ? "◀ left" : "right ▶") : "thinking…")))),
    v.is_host && others.some((t) => !v.bets[String(t.idx)]) && h("button", { class: "btn block", onclick: () => send({ type: "reveal" }) }, "Host: reveal now"),
  ];
}

function revealPhase() {
  const t = team(v.team);
  const label = { 4: "🎯 BULLSEYE!", 3: "So close!", 2: "Not bad!", 0: "Missed!" }[v.points];
  return [
    ends(v.card),
    dial({ target: v.target, needle: v.needle, reveal: true }).el,
    h("div", { class: "center stack", style: { gap: ".3rem" } },
      h("div", { class: "result-big", style: { color: v.points ? "#3ccf7f" : "#ef6a50" } }, label),
      h("b", null, `Team ${t.name} +${v.points}`)),
    Object.keys(v.bets).length ? h("div", { class: "card tight list" }, Object.entries(v.bets).map(([idx, side]) => {
      const bt = team(Number(idx));
      const won = (v.deltas[idx] || 0) > 0;
      return h("div", { class: "list-item" }, h("span", { class: "team-dot", style: { "--team": bt.color } }),
        h("span", { class: "grow" }, `${bt.name} bet ${side === "left" ? "◀ left" : "right ▶"}`),
        h("b", { style: { color: won ? "#3ccf7f" : "var(--muted)" } }, won ? "+1" : v.points === 4 ? "bullseye: no bet" : "✗"));
    })) : null,
    v.is_giver || v.is_host
      ? h("button", { class: "btn primary xl block", onclick: () => send({ type: "next" }) }, "Next ▶")
      : h("div", { class: "card center small muted" }, `Waiting for ${P(v.giver).name} to continue…`),
  ];
}

// ---------------------------------------------------------------- needle sync (throttled)
let pendingNeedle = null;
let needleTimer = null;
function queueNeedle(value) {
  pendingNeedle = value;
  if (!needleTimer) needleTimer = setTimeout(flushNeedle, 120);
}
function flushNeedle() {
  clearTimeout(needleTimer);
  needleTimer = null;
  if (pendingNeedle == null) return;
  const value = pendingNeedle;
  pendingNeedle = null;
  GC.act({ type: "needle", value }).catch(() => {});
}
document.addEventListener("pointerdown", (e) => { if (e.target.closest?.(".dial.draggable")) dragging = true; });
for (const ev of ["pointerup", "pointercancel"]) document.addEventListener(ev, () => { if (dragging) { dragging = false; flushNeedle(); } });

// ---------------------------------------------------------------- render
function render() {
  const key = `${v.turn}-${v.phase}`;
  if (key === shownKey && v.phase === "guess" && live) {
    // only the needle moved: update it in place (never under a finger that is dragging)
    if (!dragging && pendingNeedle == null) live.set(v.needle, true);
    return;
  }
  if (key !== shownKey && v.phase === "reveal") (v.points >= 3 ? sound.win() : v.points ? sound.correct() : sound.skip());
  if (key !== shownKey && v.phase === "clue" && v.is_giver) try { navigator.vibrate?.(200); } catch { /* ignore */ }
  shownKey = key;
  live = null;
  const phases = { clue: cluePhase, guess: guessPhase, bet: betPhase, reveal: revealPhase };
  mount(root, h("div", { class: "screen" }, h("div", { class: "wrap" }, topBar(), ...phases[v.phase](), standings())));
}

export function runMulti() {
  mount(root, h("div", { class: "screen centered" }, h("div", { class: "spinner" })));
  document.addEventListener("pointerdown", () => sound.unlock(), { once: true });
  GC.connect((s) => {
    session = s;
    if (s.status === "finished" || s.status === "abandoned") return GC.exit();
    if (s.status === "lobby" || !s.view) { location.href = `/#/sessions/${s.id}`; return; }
    if (v && !v.is_host && s.view.is_host) toast("👑 You're now the host", "good");
    const hostChanged = v && v.is_host !== s.view.is_host;
    v = s.view;
    if (hostChanged) shownKey = null; // redraw the host controls
    render();
  });
}
