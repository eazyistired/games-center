// Live sessions in the shell: identity, heartbeat + takeover approvals, session page, invite QR.
import { api } from "/static/api.js";
import { h, mount, toast, modal, ago, fmtDate, empty } from "/static/ui.js";
import { go, rerender } from "../app.js";
import { topbar } from "./components.js";

const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

// ---------------------------------------------------------------- identity
export const me = { player: null, loaded: false };

function setMe(player) {
  const changed = (me.player?.id ?? null) !== (player?.id ?? null);
  me.player = player;
  me.loaded = true;
  if (changed) rerender(); // "you're in this" badges etc. depend on who this phone is
}

export async function chooseMe({ firstTime = false } = {}) {
  const players = await api("/api/players");
  let picked = me.player?.id ?? null;
  const grid = h("div", { class: "chips" });
  const draw = () => mount(grid, players.map((p) => h("span", { class: `chip ${picked === p.id ? "on" : ""}`, onclick: () => { picked = p.id; draw(); } },
    h("span", { class: "e" }, p.emoji), p.name)));
  draw();
  const r = await modal(firstTime ? "👋 Who are you?" : "Who's using this phone?", h("div", { class: "stack" },
    h("p", { class: "muted small", style: { margin: 0 } }, "This phone will remember it, so you can jump into games you're in. No login, and you can change it any time."),
    grid), [
    { label: firstTime ? "Just browsing" : "Nobody / clear", class: "ghost", value: "none" },
    { label: "That's me", class: "primary", onclick: () => (picked == null ? (toast("Tap your name first", "bad"), false) : "pick") },
  ]);
  ls.set("gc.meAsked", "1");
  if (r === "pick" || r === "none") {
    const out = await api("/api/devices/me", { method: "PUT", body: { player_id: r === "pick" ? picked : null } });
    setMe(out.player);
    toast(out.player ? `Hi ${out.player.emoji} ${out.player.name}!` : "Okay, just browsing", "good");
  }
}

// ---------------------------------------------------------------- heartbeat & approvals
const answered = new Set();

async function answer(req) {
  if (answered.has(req.id)) return;
  answered.add(req.id);
  const who = req.requester ? `${req.requester.emoji} ${req.requester.name}` : "Someone";
  const text = req.reason === "identity"
    ? `A phone that says it's ${who} wants to take over ${req.game.emoji} ${req.game.name}. Was that you?`
    : `${who}'s phone wants to take over ${req.game.emoji} ${req.game.name}, which runs on this phone.`;
  const allow = await modal("Take over this game?", h("p", { class: "muted" }, text), [
    { label: "Deny", class: "ghost", value: false },
    { label: "Allow", class: "primary", value: true },
  ]);
  await api(`/api/takeover/${req.id}/decide`, { method: "POST", body: { approve: !!allow } }).catch(() => {});
}

async function beat() {
  if (document.visibilityState !== "visible") return;
  try {
    const r = await api("/api/devices/heartbeat", { method: "POST", body: { label: navigator.userAgent.slice(0, 100) } });
    if (!me.loaded || me.player?.id !== r.device.player?.id) setMe(r.device.player);
    r.requests.forEach(answer);
  } catch { /* offline */ }
}

export function startLive() {
  beat().then(() => {
    if (!me.player && !ls.get("gc.meAsked")) chooseMe({ firstTime: true }).catch(() => {});
  });
  setInterval(beat, 15000);
  document.addEventListener("visibilitychange", beat);
}

// ---------------------------------------------------------------- status chips
export const STATUS = {
  playing: { label: "Playing", cls: "good", dot: "🟢" },
  paused: { label: "Paused", cls: "warn", dot: "⏸" },
  finished: { label: "Finished", cls: "", dot: "✅" },
  abandoned: { label: "Abandoned", cls: "", dot: "✖" },
  void: { label: "Void", cls: "bad", dot: "🚫" },
};
export const statusChip = (st) => {
  const s = STATUS[st] || { label: st, cls: "", dot: "" };
  return h("span", { class: `badge ${s.cls}` }, `${s.dot} ${s.label}`);
};

const isMine = (s) => me.player && s.participants.some((p) => p.player_id === me.player.id);
const controllerText = (s) => {
  if (s.controlled_by_me) return "on this phone";
  const p = s.controller?.player;
  const where = p ? `on ${p.emoji} ${p.name}'s phone` : "on a phone";
  if (s.live_status === "playing") return where;
  return s.controller?.seen_at ? `${where} · quiet since ${ago(s.controller.seen_at)}` : "nobody has it open";
};

/** Card used on Home ("Live now") and on a night page. */
export function liveCard(s) {
  const mine = isMine(s);
  return h("div", { class: `card tight click live-card ${mine ? "mine" : ""}`, onclick: () => go(`/sessions/${s.id}`) },
    h("div", { class: "row between" },
      h("div", { class: "row" }, h("span", { style: { fontSize: "1.8rem" } }, s.game.emoji),
        h("div", null, h("b", null, s.game.name), h("div", { class: "tiny muted" }, `${controllerText(s)} · started ${ago(s.started_at)}`))),
      statusChip(s.live_status)),
    h("div", { class: "row between", style: { marginTop: ".4rem" } },
      h("span", { style: { fontSize: "1.2rem", letterSpacing: "1px" } }, s.participants.map((p) => p.emoji).join("")),
      mine ? h("span", { class: "badge gold" }, "You're in this") : null));
}

// ---------------------------------------------------------------- session page
export async function sessionView({ params }) {
  const s = await api(`/api/sessions/${params[0]}`);
  if (s.status === "finished") { go(`/results/${s.id}`); return null; }
  const mine = isMine(s);
  const actions = [];
  if (s.status === "active") {
    if (s.controlled_by_me) actions.push(h("a", { class: "btn primary xl block", href: s.game.url }, "▶ Back to the game"));
    else {
      actions.push(h("a", { class: "btn primary xl block", href: s.game.url }, "📱 Take over on this phone"));
      actions.push(h("p", { class: "small muted center", style: { margin: 0 } },
        s.live_status === "playing"
          ? "The phone that has it now will be asked to allow it. The game continues from the start of the round."
          : "That phone has gone quiet, so you can continue right away from the start of the round."));
    }
    if (s.controlled_by_me || s.live_status === "paused") {
      actions.push(h("button", { class: "btn ghost block", onclick: async () => {
        const ok = await modal("Discard this game?", h("p", { class: "muted" }, "It won't count for the leaderboards."), [
          { label: "Keep it", class: "ghost", value: false }, { label: "Discard", class: "danger", value: true }]);
        if (!ok) return;
        try { await api(`/api/sessions/${s.id}/abandon`, { method: "POST" }); go("/"); } catch (e) { toast(e.message, "bad"); }
      } }, "🗑 Discard game"));
    }
  }
  return h("div", { class: "stack" },
    topbar(`${s.game.emoji} ${s.game.name}`, true),
    h("div", { class: "card stack" },
      h("div", { class: "row between" }, statusChip(s.live_status), h("span", { class: "small muted" }, `${s.mode === "teams" ? "Teams" : "Solo"} · ${fmtDate(s.night.date)}`)),
      h("div", { class: "small muted" }, `Started ${ago(s.started_at)} · ${controllerText(s)}`),
      mine && h("div", { class: "badge gold", style: { alignSelf: "flex-start" } }, `${me.player.emoji} You're in this game`)),
    s.mode === "teams"
      ? s.teams.map((t) => h("div", { class: "card tight team-col", style: { "--team": t.color } },
          h("b", null, h("span", { class: "team-dot" }), t.name),
          h("div", { class: "chips", style: { marginTop: ".4rem" } }, t.player_ids.map((id) => s.participants.find((p) => p.player_id === id))
            .map((p) => h("span", { class: `chip sm static ${me.player?.id === p.player_id ? "on" : ""}` }, h("span", { class: "e" }, p.emoji), p.name)))))
      : h("div", { class: "card tight chips" }, s.participants.map((p) => h("span", { class: `chip sm static ${me.player?.id === p.player_id ? "on" : ""}` }, h("span", { class: "e" }, p.emoji), p.name))),
    s.status !== "active" ? h("div", { class: "card muted" }, "This game is no longer running.") : null,
    ...actions);
}

// ---------------------------------------------------------------- invite
export async function inviteView() {
  const url = location.origin + "/";
  return h("div", { class: "stack center", style: { alignItems: "center" } },
    topbar("Invite", true),
    h("p", { class: "muted", style: { margin: 0 } }, "Scan to open the games on your phone"),
    h("img", { src: `/api/qr.svg?data=${encodeURIComponent(url)}`, alt: "QR code", class: "qr" }),
    h("div", { class: "logo", style: { fontSize: "1.3rem" } }, url.replace(/^https?:\/\//, "").replace(/\/$/, "")),
    h("p", { class: "small muted", style: { maxWidth: "340px" } }, "Then pick your name. Live games show up on the home screen and under Nights."));
}

export { empty };
