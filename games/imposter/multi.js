// Imposter on everyone's phones. The server engine decides everything; this page renders
// session.view (only what THIS phone may see) and sends actions.
import { h, mount, toast, modal, confirmDialog } from "/static/ui.js";
import { createSound } from "/static/gamekit.js";

const GC = window.GC;
const root = document.getElementById("game");
let v = null; // current view
let session = null;
let tick = null;
let lastPhase = null;
let holding = false; // a card is being held: don't redraw under the player's finger
let pendingRender = false;
const sound = createSound(() => session?.settings?.sounds !== false);

const P = (id) => v.players.find((p) => p.id === id) || { name: "?", emoji: "🙂" };
const nm = (id) => `${P(id).emoji} ${P(id).name}`;
const send = (action) => GC.act(action).catch((e) => toast(e.message, "bad"));

// ---------------------------------------------------------------- pieces
function topBar() {
  return h("div", { class: "bar" },
    v.is_host ? h("button", { class: "btn small ghost", onclick: hostMenu }, "👑 Host") : h("span", { class: "badge" }, `${nm(v.me)}`),
    h("span", { class: "badge" }, `Round ${v.round} / ${v.rounds}`));
}

async function hostMenu() {
  const canSkip = ["reveal", "clues", "discuss"].includes(v.phase);
  const choice = await modal("Host menu", h("p", { class: "muted" }, "Finishing now saves the points from the rounds played so far."), [
    canSkip && { label: "New word (redo round)", value: "skip" },
    { label: "Finish now", value: "finish" },
    { label: "Close", class: "primary", value: null },
  ].filter(Boolean));
  if (choice === "skip") send({ type: "skip_word" });
  if (choice === "finish" && await confirmDialog("Finish the game?", "Points from completed rounds are saved.", "Finish")) send({ type: "finish" });
}

/** Press & hold to see your own card (so neighbours can't peek). */
function secretCard(big = true) {
  const c = v.card;
  const card = h("div", { class: "secret", style: big ? {} : { aspectRatio: "auto", minHeight: "140px", maxHeight: "none" } });
  const closed = () => { card.classList.remove("open", "imp"); mount(card, h("div", { class: "big" }, "👆"), h("div", { class: "hold" }, big ? "Press & hold to see your card" : "Hold to peek at your card")); };
  const open = () => {
    card.classList.add("open");
    if (c.role === "imposter") {
      card.classList.add("imp");
      mount(card, h("div", { class: "big" }, "🕵️"), h("div", { class: "role" }, "You're the IMPOSTER"),
        h("div", { class: "cat" }, c.category ? `Category: ${c.category}` : "No hint: listen carefully!"),
        c.n_imp > 1 && h("div", { class: "tiny muted" }, `There are ${c.n_imp} imposters`));
    } else {
      mount(card, h("div", { class: "cat" }, c.category), h("div", { class: "word" }, c.word));
    }
  };
  card.addEventListener("pointerdown", (e) => { e.preventDefault(); holding = true; open(); });
  const release = () => {
    closed();
    if (!holding) return;
    holding = false;
    if (pendingRender) { pendingRender = false; render(); }
  };
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) card.addEventListener(ev, release);
  card.addEventListener("contextmenu", (e) => e.preventDefault());
  closed();
  return card;
}

const avatars = (ids, cls = "") => h("div", { class: `row wrap ${cls}`, style: { justifyContent: "center", gap: ".35rem" } },
  v.players.map((p) => h("span", { class: `chip sm static ${ids.includes(p.id) ? "on" : ""}`, style: ids.includes(p.id) ? {} : { opacity: ".45" } },
    h("span", { class: "e" }, p.emoji), p.name)));

function scoreList(deltas = {}) {
  const rows = v.scoreboard.slice().sort((a, b) => (b.score + (deltas[b.player_id] || 0)) - (a.score + (deltas[a.player_id] || 0)));
  return h("div", { class: "card tight list" }, rows.map((r, i) => h("div", { class: "list-item" },
    h("span", { class: "muted", style: { width: "1.5rem" } }, i + 1),
    h("span", { style: { fontSize: "1.3rem" } }, r.emoji),
    h("span", { class: "grow", style: { fontWeight: 650 } }, r.name, r.player_id === v.me ? " (you)" : ""),
    h("span", { class: "score" }, r.score, deltas[r.player_id] ? h("span", { class: "delta" }, `+${deltas[r.player_id]}`) : null))));
}

// ---------------------------------------------------------------- phases
function reveal() {
  const done = v.seen.includes(v.me);
  return [
    h("div", { class: "center" }, h("h2", { style: { margin: ".25rem 0" } }, "🤫 Your card"), h("div", { class: "small muted" }, "Hold it so nobody else sees, then tap Got it.")),
    h("div", { style: { display: "flex", justifyContent: "center" } }, secretCard()),
    done
      ? h("div", { class: "card center" }, h("b", null, "✓ Got it"), h("div", { class: "small muted" }, `Waiting for ${v.players.length - v.seen.length} more…`), avatars(v.seen))
      : h("button", { class: "btn primary xl block", onclick: () => send({ type: "seen" }) }, "Got it"),
  ];
}

function clues() {
  const mine = v.current === v.me;
  const order = v.clue_order;
  return [
    mine
      ? h("div", { class: "card banner center stack", style: { gap: ".4rem" } },
          h("div", { style: { fontSize: "2.4rem" } }, "🗣️"), h("h2", { style: { margin: 0 } }, "Your turn!"),
          h("div", null, "Say ONE word about the secret, out loud."),
          h("button", { class: "btn xl", onclick: () => send({ type: "clue_done" }) }, "✓ I said my word"))
      : h("div", { class: "card center stack", style: { gap: ".3rem" } },
          h("div", { class: "hand-emoji", style: { fontSize: "3.5rem" } }, P(v.current).emoji),
          h("h2", { style: { margin: 0 } }, `${P(v.current).name} is giving a clue…`),
          h("div", { class: "small muted" }, v.lap > 1 ? `Lap ${v.lap}` : "Listen carefully!")),
    h("div", { class: "card tight list" }, order.map((id, i) => h("div", { class: "list-item" },
      h("span", { style: { width: "1.6rem" } }, i < v.clue_idx || v.clues_given >= order.length * v.lap ? "✓" : i === v.clue_idx ? "▶" : i + 1),
      h("span", { class: "grow", style: { fontWeight: i === v.clue_idx ? 800 : 500 } }, nm(id), id === v.me ? " (you)" : "")))),
    secretCard(false),
    v.is_host && h("div", { class: "row" },
      h("button", { class: "btn grow", onclick: () => send({ type: "clue_done" }) }, "Skip turn"),
      h("button", { class: "btn grow", onclick: () => send({ type: "start_vote" }) }, "🗳️ Vote now")),
  ];
}

function discuss() {
  const timer = h("div", { class: "timer-big" }, "");
  const ends = v.ends_in != null ? Date.now() + v.ends_in * 1000 : null;
  const draw = () => {
    if (!ends) return;
    const left = Math.max(0, Math.round((ends - Date.now()) / 1000));
    timer.textContent = left ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "Vote!";
    timer.classList.toggle("low", left <= 15);
    if (left <= 5 && left > 0) sound.tick();
  };
  clearInterval(tick);
  if (ends) { draw(); tick = setInterval(draw, 1000); }
  return [
    h("div", { class: "center stack", style: { gap: ".4rem" } },
      h("div", { style: { fontSize: "3rem" } }, "🤔"), h("h2", { style: { margin: 0 } }, "Discuss: who's faking it?"),
      ends && timer,
      !v.is_host && h("div", { class: "small muted" }, "The host starts the vote when you're ready.")),
    secretCard(false),
    v.is_host && h("button", { class: "btn primary xl block", onclick: () => send({ type: "start_vote" }) }, "🗳️ Start the secret vote"),
    v.is_host && h("button", { class: "btn block", onclick: () => send({ type: "next_lap" }) }, "🔁 Another lap of clues"),
  ];
}

let draft = { key: null, picked: new Set() }; // survives re-renders while others vote

function vote() {
  const allowed = v.candidates || v.players.map((p) => p.id);
  const key = `${v.round}-${v.runoff}`;
  if (draft.key !== key) draft = { key, picked: new Set(v.my_vote || []) };
  const picked = draft.picked;
  const locked = !!v.my_vote;
  const grid = h("div", { class: "vote-grid" });
  const go = h("button", { class: "btn primary xl block" });
  const draw = () => {
    mount(grid, v.players.filter((p) => allowed.includes(p.id) && p.id !== v.me).map((p) => h("button", {
      class: `vote ${picked.has(p.id) ? "on" : ""}`,
      onclick: () => {
        if (picked.has(p.id)) picked.delete(p.id);
        else { if (picked.size >= v.slots) picked.delete([...picked][0]); picked.add(p.id); }
        draw();
      },
    }, h("span", { class: "e" }, p.emoji), p.name)));
    const ready = picked.size === v.slots;
    const same = locked && [...picked].sort().join() === [...(v.my_vote || [])].sort().join();
    go.disabled = !ready || same;
    go.textContent = same ? "✓ Vote sent (tap someone to change)" : ready ? (locked ? "Change my vote" : "🗳️ Send my vote") : `Pick ${v.slots - picked.size} more`;
    go.onclick = () => send({ type: "vote", targets: [...picked] });
  };
  draw();
  return [
    h("div", { class: "center" },
      h("h2", { style: { margin: ".25rem 0" } }, v.runoff ? "⚖️ Tie! Vote again" : "🗳️ Secret vote"),
      h("div", { class: "small muted" }, v.runoff
        ? `Only between: ${v.candidates.map(nm).join(", ")}. Still tied = nobody is caught.`
        : v.n_imp > 1 ? `Pick the ${v.n_imp} players you think are imposters.` : "Who do you think is the imposter? Nobody sees your vote.")),
    grid, go,
    h("div", { class: "card center small" }, `${v.voted.length}/${v.players.length} voted`, avatars(v.voted)),
  ];
}

function guess() {
  const blocks = [];
  for (const g of v.guessing) {
    const mine = g.player_id === v.me;
    if (g.text == null) {
      if (mine) {
        const input = h("input", { placeholder: "The secret word was…", autocomplete: "off", maxlength: 80 });
        blocks.push(h("div", { class: "card banner stack" },
          h("h2", { style: { margin: 0 } }, "😬 You were caught!"),
          h("div", null, "Last chance: type the secret word. Get it right and you still score."),
          input, h("button", { class: "btn xl", onclick: () => send({ type: "guess", text: input.value }) }, "Submit guess")));
        setTimeout(() => input.focus(), 50);
      } else blocks.push(h("div", { class: "card center" }, h("div", { style: { fontSize: "2.4rem" } }, P(g.player_id).emoji),
        h("b", null, `Caught: ${P(g.player_id).name}!`), h("div", { class: "small muted" }, "They're typing their guess of the word…")));
    } else if (g.correct == null) {
      blocks.push(h("div", { class: "card center stack", style: { gap: ".4rem" } },
        h("div", null, `${nm(g.player_id)} guessed:`), h("div", { style: { fontSize: "1.8rem", fontWeight: 900 } }, `“${g.text}”`),
        v.is_host
          ? h("div", { class: "row", style: { justifyContent: "center" } },
              h("button", { class: "btn good", onclick: () => send({ type: "judge", player_id: g.player_id, correct: true }) }, "✓ Count it"),
              h("button", { class: "btn danger", onclick: () => send({ type: "judge", player_id: g.player_id, correct: false }) }, "✗ Wrong"))
          : h("div", { class: "small muted" }, "Not an exact match: the host decides.")));
    }
  }
  return blocks;
}

function result() {
  const r = v.reveal;
  const caught = r.imposters.filter((i) => r.accused.includes(i));
  const escaped = r.imposters.filter((i) => !r.accused.includes(i));
  const verdict = !caught.length ? h("div", { class: "verdict bad" }, v.n_imp > 1 ? "The imposters got away! 😈" : "The imposter got away! 😈")
    : escaped.length ? h("div", { class: "verdict" }, "Half right! 🤏") : h("div", { class: "verdict good" }, v.n_imp > 1 ? "Both imposters caught! 🎉" : "Imposter caught! 🎉");
  const votesFor = {};
  for (const [voter, targets] of Object.entries(r.runoff_votes || r.votes)) for (const t of targets) (votesFor[t] ||= []).push(Number(voter));
  return [
    h("div", { class: "center stack", style: { gap: ".4rem" } },
      h("div", { class: "muted" }, r.imposters.length > 1 ? "The imposters were" : "The imposter was"),
      h("div", { class: "hand-name" }, r.imposters.map(nm).join(" & ")),
      verdict),
    h("div", { class: "card center" }, h("div", { class: "small muted" }, "The word was"),
      h("div", { style: { fontSize: "2rem", fontWeight: 900 } }, r.word), h("div", { class: "small muted" }, r.category),
      v.guessing.map((g) => h("div", { class: "small", style: { marginTop: ".3rem" } }, `${nm(g.player_id)} guessed “${g.text}” ${g.correct ? "✓" : "✗"}`))),
    h("div", { class: "card tight list" }, h("div", { class: "small muted", style: { padding: ".25rem" } }, r.runoff_votes ? "Votes (re-vote)" : "Votes"),
      v.players.filter((p) => votesFor[p.id]).sort((a, b) => votesFor[b.id].length - votesFor[a.id].length).map((p) => h("div", { class: "list-item" },
        h("span", { class: "grow" }, `${p.emoji} ${p.name}`, r.imposters.includes(p.id) ? " 🕵️" : ""),
        h("span", { class: "small muted" }, votesFor[p.id].map((id) => P(id).emoji).join(" "))))),
    scoreList(),
    v.is_host
      ? h("button", { class: "btn primary xl block", onclick: () => send(v.last_round ? { type: "finish" } : { type: "next_round" }) },
          v.last_round ? "🏁 Final scores" : "Next round ▶")
      : h("div", { class: "card center small muted" }, "Waiting for the host…"),
  ];
}

// ---------------------------------------------------------------- render
function render() {
  if (holding) { pendingRender = true; return; }
  const phases = { reveal, clues, discuss, vote, guess, result };
  if (v.phase !== "discuss") clearInterval(tick);
  if (v.phase !== lastPhase) {
    if (v.phase === "result") (v.reveal.imposters.every((i) => v.reveal.accused.includes(i)) ? sound.win() : sound.skip());
    else if (lastPhase) sound.count();
    if (v.phase === "clues" && v.current === v.me) try { navigator.vibrate?.(200); } catch { /* ignore */ }
    lastPhase = v.phase;
  }
  mount(root, h("div", { class: "screen" }, h("div", { class: "wrap" }, topBar(), ...phases[v.phase]())));
}

export function runMulti() {
  mount(root, h("div", { class: "screen centered" }, h("div", { class: "spinner" })));
  document.addEventListener("pointerdown", () => sound.unlock(), { once: true });
  GC.connect((s) => {
    session = s;
    if (s.status === "finished" || s.status === "abandoned") return GC.exit();
    if (s.status === "lobby" || !s.view) { location.href = `/#/sessions/${s.id}`; return; }
    v = s.view;
    // don't wipe a half-typed guess or a vote in progress when someone else's update arrives
    if (document.activeElement?.tagName === "INPUT" && v.phase === "guess") return;
    render();
  });
}
