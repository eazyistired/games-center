// Tuned In - teams. The clue-giver secretly sees a target on a dial between two extremes,
// says a clue, and their team turns the dial to find it. Other teams bet left/right.
import { h, mount, toast, confirmDialog, modal } from "/static/ui.js";
import { shuffle, createSound, goImmersive } from "/static/gamekit.js";
import { dial, ends, pointsFor } from "/static/dial.js";

const GC = window.GC;
const root = document.getElementById("game");


let session, teams, byId, sound, PAIRS = [];
const st = { turnNo: 0, teamTurns: {}, scores: {}, used: [], log: [] };
let deckOrder = [];

const pName = (id) => byId.get(id)?.name || "?";
const pEmoji = (id) => byId.get(id)?.emoji || "🙂";
const teamOf = (idx) => teams.find((t) => t.idx === idx);
const save = () => {
  const partial = st.log.length ? {
    scores: teams.map((t) => ({ team: t.idx, score: st.scores[t.idx] || 0 })),
    details: { summary: `${st.log.length} turns played`, turns: st.log },
  } : null;
  return GC.saveProgress({ ...st }, partial).catch(() => toast("Couldn't save progress (offline?)", "bad"));
};
const playTo = () => Number(session.settings.play_to) || 10;

// avoid repeating cards tonight on this phone (and within the game via st.used)
const nightKey = () => `gc.tunedin.used.${new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10)}`;
const lsGet = () => { try { return JSON.parse(localStorage.getItem(nightKey())) || []; } catch { return []; } };
const lsAdd = (i) => { try { localStorage.setItem(nightKey(), JSON.stringify([...new Set([...lsGet(), i])])); } catch { /* ignore */ } };

function drawCard() {
  if (!deckOrder.length) {
    const used = new Set([...st.used, ...lsGet()]);
    let fresh = PAIRS.map((_, i) => i).filter((i) => !used.has(i));
    if (!fresh.length) fresh = PAIRS.map((_, i) => i).filter((i) => !st.used.includes(i));
    if (!fresh.length) fresh = PAIRS.map((_, i) => i);
    deckOrder = shuffle(fresh);
  }
  return deckOrder.pop();
}

function currentTurn() {
  const team = teams[st.turnNo % teams.length];
  const n = st.teamTurns[team.idx] || 0;
  return { team: team.idx, player_id: team.player_ids[n % team.player_ids.length] };
}

// ------------------------------------------------------------------ shared UI
function standingsList(deltas = {}) {
  const rows = teams.map((t) => ({ t, score: (st.scores[t.idx] || 0) + (deltas[t.idx] || 0) })).sort((a, b) => b.score - a.score);
  return h("div", { class: "card tight list" }, rows.map(({ t, score }, i) => h("div", { class: "list-item" },
    h("span", { class: "muted", style: { width: "1.4rem" } }, i + 1),
    h("span", { class: "team-dot", style: { "--team": t.color } }),
    h("span", { class: "grow" }, h("b", null, t.name), " ", t.player_ids.map(pEmoji).join("")),
    h("span", { class: "score" }, score, deltas[t.idx] ? h("span", { class: "delta" }, `+${deltas[t.idx]}`) : null, h("span", { class: "muted small" }, ` / ${playTo()}`)))));
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

const topBar = () => h("div", { class: "bar" },
  h("button", { class: "btn small ghost", onclick: menu }, "☰ Menu"),
  h("span", { class: "badge" }, `Turn ${st.turnNo + 1} · play to ${playTo()}`));

// ------------------------------------------------------------------ screens
function introScreen() {
  const resuming = st.turnNo > 0;
  const demo = dial({ target: 0.68, needle: 0.62 });
  mount(root, h("div", { class: "screen" }, h("div", { class: "wrap" },
    h("div", { class: "bar" },
      h("button", { class: "back", onclick: () => (resuming ? menu() : GC.quit()) }, "‹"),
      h("div", { class: "logo" }, "TUNED IN"),
      h("span", { class: "badge" }, `${teams.length} teams`)),
    demo.el,
    h("div", { class: "card stack" },
      h("h2", { style: { margin: 0 } }, resuming ? `Welcome back! Turn ${st.turnNo + 1}` : "How to play"),
      h("div", { class: "small muted stack", style: { gap: ".35rem" } },
        h("div", null, "📡 The clue-giver secretly sees where the target sits between two extremes, e.g. Cold ↔ Hot."),
        h("div", null, "💬 They say ONE clue that sits right there (\"a sauna\", \"soup\"…). No numbers, no pointing!"),
        h("div", null, "🎛️ Their team talks it over and turns the dial to where they think the target is."),
        session.settings.bet && h("div", null, "🎲 The other team(s) bet: is the target left or right of the needle? +1 if right."),
        h("div", null, `🎯 Bullseye 4 · close 3 · near 2. First to ${playTo()} wins (after equal turns).`))),
    resuming && standingsList(),
    h("button", { class: "btn primary xl block", onclick: () => { sound.unlock(); goImmersive(); handoffScreen(); } }, resuming ? "▶ Continue" : "▶ Start"))));
}

function handoffScreen() {
  const turn = currentTurn();
  const team = teamOf(turn.team);
  mount(root, h("div", { class: "screen" }, topBar(), h("div", { class: "screen centered", style: { background: `linear-gradient(180deg, ${team.color}33, transparent 70%)` } },
    h("span", { class: "team-pill", style: { background: team.color } }, `Team ${team.name}`),
    h("div", { class: "muted" }, "Clue-giver: take the phone"),
    h("div", { class: "hand-emoji" }, pEmoji(turn.player_id)),
    h("div", { class: "hand-name" }, pName(turn.player_id)),
    h("div", { class: "secret-warn" }, "🙈 Everyone else: don't look at the screen!"),
    h("button", { class: "btn primary xl", style: { minWidth: "60%" }, onclick: () => { sound.unlock(); secretScreen(turn, drawCard(), 0); } }, `I'm ${pName(turn.player_id)}`),
    h("div", { style: { width: "100%", maxWidth: "480px" } }, standingsList()))));
}

function secretScreen(turn, cardIdx, swapsUsed) {
  const pair = PAIRS[cardIdx];
  const target = 0.03 + Math.random() * 0.94;
  const maxSwaps = session.settings.swaps == null ? 1 : Number(session.settings.swaps);
  const d = dial({ target, needle: target });
  mount(root, h("div", { class: "screen" }, h("div", { class: "wrap" },
    topBar(),
    h("div", { class: "center" }, h("b", { class: "secret-warn" }, `🤫 Only ${pName(turn.player_id)} looks`)),
    ends(pair),
    d.el,
    h("div", { class: "card small" }, "Think of a clue that sits ", h("b", null, "right on the red zone"), ` between “${pair[0]}” and “${pair[1]}”. One thing, no numbers.`),
    h("div", { class: "row" },
      maxSwaps > 0 && h("button", { class: "btn", disabled: swapsUsed >= maxSwaps, onclick: () => secretScreen(turn, drawCard(), swapsUsed + 1) },
        `🔄 Other card (${Math.max(0, maxSwaps - swapsUsed)})`),
      h("button", { class: "btn primary grow", onclick: () => guessScreen(turn, cardIdx, target) }, "Got a clue: hide it")))));
}

function guessScreen(turn, cardIdx, target) {
  const pair = PAIRS[cardIdx];
  const team = teamOf(turn.team);
  const d = dial({ needle: 0.5, draggable: true });
  const nudge = (dv) => h("button", { class: "btn small", onclick: () => d.set(d.value + dv) }, dv < 0 ? "◀" : "▶");
  mount(root, h("div", { class: "screen" }, h("div", { class: "wrap" },
    topBar(),
    h("div", { class: "center" },
      h("span", { class: "team-pill", style: { background: team.color } }, `Team ${team.name}`),
      h("h2", { style: { margin: ".5rem 0 0" } }, `${pEmoji(turn.player_id)} ${pName(turn.player_id)}: say your clue!`),
      h("div", { class: "small muted" }, "Team: discuss, then drag the needle to where you think the target is.")),
    ends(pair),
    d.el,
    h("div", { class: "nudge" }, nudge(-0.01), h("span", { class: "small muted", style: { alignSelf: "center" } }, "fine-tune"), nudge(0.01)),
    h("button", { class: "btn primary xl block", onclick: () => {
      const needle = d.value;
      if (session.settings.bet && teams.length > 1) betScreen(turn, cardIdx, target, needle);
      else revealScreen(turn, cardIdx, target, needle, {});
    } }, "🔒 Lock it in"))));
}

function betScreen(turn, cardIdx, target, needle) {
  const pair = PAIRS[cardIdx];
  const others = teams.filter((t) => t.idx !== turn.team);
  const bets = {};
  const rows = h("div", { class: "stack" });
  const go = h("button", { class: "btn primary xl block", disabled: true, onclick: () => revealScreen(turn, cardIdx, target, needle, bets) });
  const draw = () => {
    mount(rows, others.map((t) => h("div", { class: "bet-row" },
      h("span", { class: "team-dot", style: { "--team": t.color } }),
      h("span", { class: "name" }, t.name),
      h("button", { class: `btn ${bets[t.idx] === "left" ? "on" : ""}`, onclick: () => { bets[t.idx] = "left"; draw(); } }, "◀ Left"),
      h("button", { class: `btn ${bets[t.idx] === "right" ? "on" : ""}`, onclick: () => { bets[t.idx] = "right"; draw(); } }, "Right ▶"))));
    const missing = others.filter((t) => !bets[t.idx]).length;
    go.disabled = missing > 0;
    go.textContent = missing ? `Waiting for ${missing} bet${missing > 1 ? "s" : ""}` : "🎯 Reveal";
  };
  draw();
  mount(root, h("div", { class: "screen" }, h("div", { class: "wrap" },
    topBar(),
    h("div", { class: "center" }, h("h2", { style: { margin: ".25rem 0" } }, "🎲 Other teams: place your bets"),
      h("div", { class: "small muted" }, "Is the real target LEFT or RIGHT of the needle? +1 if you're right.")),
    ends(pair),
    dial({ needle }).el,
    rows, go)));
}

function revealScreen(turn, cardIdx, target, needle, bets) {
  const pair = PAIRS[cardIdx];
  const team = teamOf(turn.team);
  const pts = pointsFor(Math.abs(needle - target));
  const side = target < needle ? "left" : "right";
  const deltas = {};
  if (pts) deltas[turn.team] = pts;
  const betResults = Object.entries(bets).map(([idx, guess]) => {
    const won = pts !== 4 && guess === side; // nobody wins a bet against a bullseye
    if (won) deltas[idx] = (deltas[idx] || 0) + 1;
    return { t: teamOf(Number(idx)), guess, won };
  });
  pts >= 3 ? sound.win() : pts ? sound.correct() : sound.skip();
  const label = { 4: "🎯 BULLSEYE!", 3: "So close!", 2: "Not bad!", 0: "Missed!" }[pts];
  mount(root, h("div", { class: "screen" }, h("div", { class: "wrap" },
    topBar(),
    ends(pair),
    dial({ target, needle, reveal: true }).el,
    h("div", { class: "center stack", style: { gap: ".3rem" } },
      h("div", { class: "result-big", style: { color: pts ? "#3ccf7f" : "#ef6a50" } }, label),
      h("div", null, h("b", null, `Team ${team.name} +${pts}`))),
    betResults.length ? h("div", { class: "card tight list" }, betResults.map((b) => h("div", { class: "list-item" },
      h("span", { class: "team-dot", style: { "--team": b.t.color } }),
      h("span", { class: "grow" }, `${b.t.name} bet ${b.guess === "left" ? "◀ left" : "right ▶"}`),
      h("b", { style: { color: b.won ? "#3ccf7f" : "var(--muted)" } }, b.won ? "+1" : pts === 4 ? "bullseye: no bet" : "✗")))) : null,
    standingsList(deltas),
    h("button", { class: "btn primary xl block", onclick: async (e) => {
      e.currentTarget.disabled = true;
      for (const [idx, n] of Object.entries(deltas)) st.scores[idx] = (st.scores[idx] || 0) + n;
      st.used.push(cardIdx);
      lsAdd(cardIdx);
      st.log.push({ team: turn.team, player_id: turn.player_id, card: pair, target: +target.toFixed(3), needle: +needle.toFixed(3), points: pts, bets });
      st.turnNo++;
      st.teamTurns[turn.team] = (st.teamTurns[turn.team] || 0) + 1;
      await save();
      if (isOver()) finalScreen(); else handoffScreen();
    } }, "Next ▶"))));
}

/** Game ends after a full cycle of turns when someone reached the goal and is alone on top. */
function isOver() {
  if (st.turnNo % teams.length !== 0) return false;
  const scores = teams.map((t) => st.scores[t.idx] || 0);
  const best = Math.max(...scores);
  return best >= playTo() && scores.filter((x) => x === best).length === 1;
}

function finalScreen() {
  const rows = teams.map((t) => ({ t, score: st.scores[t.idx] || 0 })).sort((a, b) => b.score - a.score);
  const bulls = st.log.filter((l) => l.points === 4);
  const best = {};
  for (const l of st.log) best[l.player_id] = (best[l.player_id] || 0) + l.points;
  const mvp = Object.entries(best).sort((a, b) => b[1] - a[1])[0];
  const summary = `${st.log.length} turns · ${bulls.length} bullseye${bulls.length === 1 ? "" : "s"}` + (mvp && mvp[1] ? ` · best clue-giver ${pName(Number(mvp[0]))} (${mvp[1]} pts)` : "");
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
          details: { summary, turns: st.log },
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
    const peek = await GC.getSession();
    if (peek.device_mode === "multi") {
      const { runMulti } = await import("./multi.js");
      return runMulti();
    }
    [session, PAIRS] = await Promise.all([GC.start(), fetch("spectrums.json").then((r) => r.json()).then((d) => d.pairs)]);
  } catch (e) {
    mount(root, h("div", { class: "screen centered" }, h("h2", null, "😵 " + e.message), h("a", { class: "btn", href: "/" }, "Home")));
    return;
  }
  if (session.status !== "active") return GC.exit();
  sound = createSound(() => session.settings.sounds);
  teams = session.teams;
  byId = new Map(session.participants.map((p) => [p.player_id, p]));
  if (session.progress) Object.assign(st, session.progress);
  introScreen();
}

boot();
