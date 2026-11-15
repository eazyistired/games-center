// Popular Opinion - everyone's phones. Answer secretly, then guess what MOST people said.
import { h, mount, toast, modal, confirmDialog } from "/static/ui.js";
import { createSound } from "/static/gamekit.js";

const GC = window.GC;
const root = document.getElementById("game");
let v = null;
let session = null;
let lastKey = null;
const sound = createSound(() => session?.settings?.sounds !== false);

const P = (id) => v.players.find((p) => p.id === id) || { name: "?", emoji: "🙂" };
const nm = (id) => `${P(id).emoji} ${P(id).name}`;
const send = (action) => GC.act(action).then(update).catch((e) => toast(e.message, "bad"));

async function menu() {
  if (v.is_host) {
    const choice = await modal("👑 Host menu", h("p", { class: "muted" }, "Finishing now saves the points so far."), [
      v.phase === "answer" && { label: "⏭ Skip this question", value: "skip" },
      { label: "👑 Make someone else host", value: "handover" },
      { label: "Finish now", value: "finish" },
      { label: "Close", class: "primary", value: null },
    ].filter(Boolean));
    if (choice === "skip") send({ type: "skip" });
    if (choice === "finish" && await confirmDialog("Finish the game?", "Points so far are saved.", "Finish")) send({ type: "finish" });
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

function standings(deltas = {}) {
  const rows = v.scoreboard.slice().sort((a, b) => b.score - a.score);
  return h("div", { class: "card tight list" }, rows.map((r, i) => h("div", { class: "list-item" },
    h("span", { class: "muted", style: { width: "1.4rem" } }, i + 1),
    h("span", { style: { fontSize: "1.3rem" } }, r.emoji),
    h("span", { class: "grow", style: { fontWeight: 650 } }, r.name, r.player_id === v.me ? " (you)" : ""),
    h("span", { class: "score" }, r.score, deltas[r.player_id] ? h("span", { class: "delta" }, `+${deltas[r.player_id]}`) : null))));
}

function answerPhase() {
  const both = v.my_answer != null && v.my_guess != null;
  const opt = (i, kind) => {
    const on = (kind === "answer" ? v.my_answer : v.my_guess) === i;
    return h("button", { class: `opt ${kind === "guess" ? "guess" : ""} ${on ? "on" : ""}`, onclick: () => send({ type: kind, option: i }) },
      v.options[i], on ? h("span", { class: "tick" }, "✓") : null);
  };
  return [
    h("div", { class: "card stack", style: { gap: ".5rem" } },
      v.spicy && h("span", { class: "badge bad spicy" }, "🔞 spicy"),
      h("div", { class: "question" }, v.question)),
    h("div", { class: "step" }, "1 · Your answer (honest!)"),
    h("div", { class: "opts" }, v.options.map((_, i) => opt(i, "answer"))),
    h("div", { class: "step" }, "2 · What will MOST people say?"),
    h("div", { class: "opts" }, v.options.map((_, i) => opt(i, "guess"))),
    h("div", { class: "card center small" },
      both ? h("b", null, "✓ Locked in (you can still change) · ") : null,
      `${v.done.length}/${v.players.length} done`,
      h("div", { class: "row wrap", style: { justifyContent: "center", gap: ".3rem", marginTop: ".4rem" } },
        v.players.map((p) => h("span", { class: `chip sm static ${v.done.includes(p.id) ? "on" : ""}`, style: v.done.includes(p.id) ? {} : { opacity: ".45" } },
          h("span", { class: "e" }, p.emoji), p.name)))),
    v.is_host && v.done.length > 0 && v.done.length < v.players.length && h("button", { class: "btn block", onclick: () => send({ type: "reveal" }) }, "Host: reveal now"),
  ];
}

function revealPhase() {
  const r = v.reveal;
  const total = r.counts.reduce((a, b) => a + b, 0) || 1;
  const mine = r.right.includes(v.me);
  const guessed = v.my_guess != null;
  return [
    h("div", { class: "card", style: { textAlign: "center" } }, h("div", { class: "question", style: { fontSize: "1.3rem" } }, v.question)),
    guessed ? h("div", { class: `verdict ${mine ? "good" : "bad"}` }, mine ? "✓ You read the room! +1" : "✗ Not what most people said") : null,
    h("div", { class: "res" }, v.options.map((o, i) => h("div", { class: `res-row ${r.majority.includes(i) ? "top" : ""}` },
      h("div", { class: "res-head" }, h("span", null, o, r.majority.includes(i) ? " 👑" : ""), h("span", null, r.counts[i])),
      h("div", { class: "res-bar" }, h("div", { style: { width: `${Math.round((100 * r.counts[i]) / total)}%` } })),
      r.who && r.who[i]?.length ? h("div", { class: "res-who" }, r.who[i].map(nm).join("  ")) : null))),
    r.wolves.length ? h("div", { class: "wolf" }, `🐺 Lone wolf: ${r.wolves.map(nm).join(", ")}`) : null,
    standings(Object.fromEntries(Object.entries(r.deltas).map(([k, n]) => [Number(k), n]))),
    v.is_host
      ? h("button", { class: "btn primary xl block", onclick: () => send({ type: "next" }) }, v.last_round ? "🏁 Final scores" : "Next question ▶")
      : h("div", { class: "card center small muted" }, "Waiting for the host…"),
  ];
}

function render() {
  const key = JSON.stringify([v.phase, v.round, v.my_answer, v.my_guess, v.done, v.is_host, v.scoreboard]);
  if (key === lastKey) return;
  if (v.phase === "reveal" && !lastKey?.startsWith('["reveal"')) (v.reveal.right.includes(v.me) ? sound.win() : sound.skip());
  lastKey = key;
  mount(root, h("div", { class: "screen" }, h("div", { class: "wrap" },
    h("div", { class: "bar" },
      h("button", { class: "btn small ghost", onclick: menu }, v.is_host ? "👑 Host" : `${nm(v.me)} ▾`),
      h("span", { class: "badge" }, `Q ${v.round} / ${v.rounds}`)),
    ...(v.phase === "answer" ? answerPhase() : revealPhase()))));
}

function update(s) {
  session = s;
  if (s.status === "finished" || s.status === "abandoned") return GC.exit();
  if (s.status === "lobby" || !s.view) { location.href = `/#/sessions/${s.id}`; return; }
  if (v && !v.is_host && s.view.is_host) toast("👑 You're now the host", "good");
  v = s.view;
  render();
}

mount(root, h("div", { class: "screen" }, h("div", { class: "spinner" })));
document.addEventListener("pointerdown", () => sound.unlock(), { once: true });
GC.connect(update);
