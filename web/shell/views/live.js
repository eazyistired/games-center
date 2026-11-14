// Live sessions in the shell: identity, heartbeat + takeover approvals, session page, invite QR.
import { api } from "/static/api.js";
import { h, mount, toast, modal, ago, fmtDate, empty, seg } from "/static/ui.js";
import { go, rerender, refresh, onLeave, parseHash } from "../app.js";
import { openSocket } from "/static/socket.js";
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
  // the "live" room: a nudge whenever any session changes -> refresh screens that list sessions
  let pending = null;
  openSocket({ onMessage: () => {
    const { path } = parseHash();
    if (!/^\/?$|^\/nights/.test(path)) return;
    clearTimeout(pending);
    pending = setTimeout(refresh, 300); // coalesce bursts
  } });
  setInterval(beat, 10000);
  document.addEventListener("visibilitychange", beat);
}

// ---------------------------------------------------------------- status chips
export const STATUS = {
  collecting: { label: "Writing words", cls: "info", dot: "✍️" },
  lobby: { label: "Waiting for players", cls: "info", dot: "🟡" },
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
  if (s.device_mode === "multi") {
    const joined = s.lobby ? s.lobby.seats.filter((x) => x.joined).length : 0;
    const host = s.controller?.player;
    return `📱📱 ${joined}/${s.participants.length} phones${host ? ` · host ${host.emoji} ${host.name}` : ""}`;
  }
  if (s.status === "collecting") {
    const host = s.controller?.player;
    return s.controlled_by_me ? "you're the host" : host ? `host ${host.emoji} ${host.name}` : "collecting words";
  }
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

// ---------------------------------------------------------------- friends write the words
function collectBlock(s, redraw, input) {
  const c = s.collect;
  const left = c.per_player - c.mine.length;
  const add = async () => {
    const text = input.value.trim();
    if (!text) return input.focus();
    try {
      const out = await api(`/api/sessions/${s.id}/words`, { method: "POST", body: { text } });
      input.value = "";
      redraw(out);
      input.focus();
    } catch (e) { toast(e.message, "bad"); }
  };
  input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } };
  const remove = async (id) => {
    try { redraw(await api(`/api/sessions/${s.id}/words/${id}`, { method: "DELETE" })); } catch (e) { toast(e.message, "bad"); }
  };
  const isHostSingle = s.status === "collecting" && s.controlled_by_me;
  return h("div", { class: "stack" },
    h("div", { class: "card stack" },
      h("div", { class: "row between" }, h("h3", { style: { margin: 0 } }, "✍️ Add your words"),
        h("span", { class: "badge gold" }, `${c.mine.length}/${c.per_player}`)),
      !c.me
        ? h("button", { class: "btn primary block", onclick: () => chooseMe() }, "👋 First, who are you?")
        : [
            h("p", { class: "small muted", style: { margin: 0 } }, "Only you see your words. Pick things everyone knows: people, movies, inside jokes…"),
            left > 0 ? h("div", { class: "row" }, input, h("button", { class: "btn primary", onclick: add }, "Add")) : h("div", { class: "small", style: { color: "#3ccf7f", fontWeight: 700 } }, "✓ All your words are in!"),
            c.mine.length ? h("div", { class: "chips" }, c.mine.map((w) => h("span", { class: "chip sm static on" }, w.text,
              h("button", { class: "btn small ghost", style: { minHeight: "24px", padding: "0 .3rem", marginLeft: ".2rem" }, onclick: () => remove(w.id) }, "✕")))) : null,
          ]),
    h("div", { class: "card tight" },
      h("div", { class: "row between", style: { padding: "0 .25rem" } }, h("b", null, "Words so far"),
        h("span", { class: "small muted" }, `${c.total} · need ${c.min_total}+`)),
      h("div", { class: "list" }, c.counts.map((x) => h("div", { class: "list-item" },
        h("span", { class: "avatar" }, x.emoji), h("span", { class: "grow" }, x.name, x.player_id === c.me ? " (you)" : ""),
        h("span", { class: `badge ${x.count >= c.per_player ? "good" : ""}` }, x.count >= c.per_player ? `✓ ${x.count}` : `${x.count}/${c.per_player}`))))),
    isHostSingle
      ? h("button", { class: "btn primary xl block", disabled: !c.ready, onclick: async () => {
          try { const out = await api(`/api/sessions/${s.id}/begin`, { method: "POST" }); location.href = out.game.url; } catch (e) { toast(e.message, "bad"); }
        } }, c.ready ? `▶ Start with ${c.total} words` : `Need ${c.min_total - c.total} more words…`)
      : s.status === "collecting" ? h("p", { class: "small muted center", style: { margin: 0 } }, "The host starts the game when everyone's done.") : null);
}

// ---------------------------------------------------------------- session page
function playerChips(s, filterIds = null) {
  const parts = filterIds ? filterIds.map((id) => s.participants.find((p) => p.player_id === id)) : s.participants;
  return h("div", { class: "chips", style: { marginTop: ".4rem" } }, parts.filter(Boolean).map((p) =>
    h("span", { class: `chip sm static ${me.player?.id === p.player_id ? "on" : ""}` }, h("span", { class: "e" }, p.emoji), p.name)));
}

async function discard(s) {
  const ok = await modal("Discard this game?", h("p", { class: "muted" }, "It won't count for the leaderboards."), [
    { label: "Keep it", class: "ghost", value: false }, { label: "Discard", class: "danger", value: true }]);
  if (!ok) return;
  try { await api(`/api/sessions/${s.id}/abandon`, { method: "POST" }); go("/"); } catch (e) { toast(e.message, "bad"); }
}

function singleActions(s) {
  const actions = [];
  if (s.controlled_by_me) actions.push(h("a", { class: "btn primary xl block", href: s.game.url }, "▶ Back to the game"));
  else {
    actions.push(h("a", { class: "btn primary xl block", href: s.game.url }, "📱 Take over on this phone"));
    actions.push(h("p", { class: "small muted center", style: { margin: 0 } },
      s.live_status === "playing"
        ? "The phone that has it now will be asked to allow it. The game continues from the start of the round."
        : "That phone has gone quiet, so you can continue right away from the start of the round."));
  }
  return actions;
}

function lobbyBlock(s, redraw) {
  const L = s.lobby;
  const seatAction = async (playerId, force = false) => {
    try {
      const out = await api(`/api/sessions/${s.id}/seat`, { method: "POST", body: { player_id: playerId, force } });
      redraw(out);
    } catch (e) {
      if (e.info?.seat_taken && L.is_host) {
        const ok = await modal("Seat in use", h("p", { class: "muted" }, `${e.message}. Move them to this phone anyway?`), [
          { label: "Cancel", class: "ghost", value: false }, { label: "Move", class: "danger", value: true }]);
        if (ok) return seatAction(playerId, true);
      } else toast(e.message, "bad");
    }
  };
  const remove = async (playerId) => {
    try { redraw(await api(`/api/sessions/${s.id}/seat/${playerId}`, { method: "DELETE" })); } catch (e) { toast(e.message, "bad"); }
  };
  const myFreeSeat = me.player && L.seats.find((x) => x.player_id === me.player.id && !x.mine);
  // a phone that knows who it is only gets "That's me" next to its own name
  const knownInLineup = !!(me.player && L.seats.some((x) => x.player_id === me.player.id));
  const seatRow = (x) => h("div", { class: "list-item" },
    h("span", { class: "avatar" }, x.emoji),
    h("div", { class: "grow" }, h("b", null, x.name, x.host ? " 👑" : ""),
      h("div", { class: "tiny muted" }, x.mine ? "this phone" : x.joined ? (x.online ? "joined · online" : "joined · reconnecting…") : "waiting…")),
    x.joined ? h("span", { class: `badge ${x.online || x.mine ? "good" : "warn"}` }, x.mine ? "You" : "✓") : null,
    !x.joined && !L.my_seat && (!knownInLineup || x.player_id === me.player.id)
      ? h("button", { class: "btn small primary", onclick: () => seatAction(x.player_id) }, "That's me") : null,
    L.is_host && x.joined && !x.mine ? h("button", { class: "btn small ghost icon-btn", title: "Remove", onclick: () => remove(x.player_id) }, "✕") : null);
  const joined = L.seats.filter((x) => x.joined).length;
  return h("div", { class: "stack" },
    h("div", { class: "card tight" },
      h("div", { class: "row between", style: { padding: "0 .25rem" } }, h("b", null, "Players"), h("span", { class: "small muted" }, `${joined}/${L.seats.length} joined`)),
      h("div", { class: "list" }, L.seats.map(seatRow))),
    myFreeSeat && !L.my_seat ? h("button", { class: "btn primary xl block", onclick: () => seatAction(myFreeSeat.player_id) }, `${me.player.emoji} Join as ${me.player.name}`) : null,
    !L.my_seat && !myFreeSeat ? h("p", { class: "small muted center", style: { margin: 0 } }, "Tap “That's me” next to your name to join on this phone.") : null,
    L.is_host
      ? h("button", { class: "btn primary xl block", disabled: !L.all_joined || (s.collect && !s.collect.ready), onclick: async () => {
          try { const out = await api(`/api/sessions/${s.id}/start`, { method: "POST" }); location.href = out.game.url; } catch (e) { toast(e.message, "bad"); }
        } }, !L.all_joined ? `Waiting for ${L.seats.length - joined} more…` : s.collect && !s.collect.ready ? `Need ${s.collect.min_total - s.collect.total} more words…` : "▶ Start the game")
      : L.my_seat ? h("div", { class: "card center small" }, "✅ You're in! The host will start the game when everyone has joined.") : null,
    L.is_host ? h("p", { class: "tiny muted center", style: { margin: 0 } }, "Everyone opens the site (📲 Invite has the QR code), finds this game under Live now and taps their name.") : null);
}

export async function sessionView({ params, app }) {
  let s = await api(`/api/sessions/${params[0]}`);
  if (s.status === "finished") { go(`/results/${s.id}`); return null; }
  const root = h("div", { class: "stack" });
  // kept across live redraws so a half-typed word isn't lost when others add theirs
  const wordInput = h("input", { placeholder: "A word or name…", maxlength: 120, autocomplete: "off", enterkeyhint: "done" });

  function draw(next) {
    if (next) s = next;
    if (s.status === "finished") { go(`/results/${s.id}`); return; }
    const mine = isMine(s);
    const multi = s.device_mode === "multi";
    const blocks = [];
    if (s.collect && (s.status === "collecting" || (multi && s.status === "lobby"))) blocks.push(collectBlock(s, draw, wordInput));
    if (multi && s.status === "lobby") blocks.push(lobbyBlock(s, draw));
    else if (multi && s.status === "active") {
      if (s.lobby.my_seat || s.lobby.is_host) blocks.push(h("a", { class: "btn primary xl block", href: s.game.url }, "▶ Open the game"));
      else if (me.player && s.lobby.seats.some((x) => x.player_id === me.player.id)) blocks.push(lobbyBlock(s, draw));
      else blocks.push(h("p", { class: "small muted center" }, "This game is already running. You can watch it live."));
    } else if (s.status === "active") blocks.push(...singleActions(s));
    if (["active", "lobby", "collecting"].includes(s.status)) {
      blocks.push(h("a", { class: "btn block", href: `#/watch/${s.id}` }, "👀 Watch live"));
      if (s.controlled_by_me || s.live_status === "paused") blocks.push(h("button", { class: "btn ghost block", onclick: () => discard(s) }, "🗑 Discard game"));
    }
    mount(root,
      topbar(`${s.game.emoji} ${s.game.name}`, true),
      h("div", { class: "card stack" },
        h("div", { class: "row between" }, statusChip(s.live_status), h("span", { class: "small muted" }, `${multi ? "📱📱 Everyone's phones" : "📱 One phone"} · ${s.mode === "teams" ? "Teams" : "Solo"}`)),
        h("div", { class: "small muted" }, `Started ${ago(s.started_at)} · ${controllerText(s)}`),
        mine && h("div", { class: "badge gold", style: { alignSelf: "flex-start" } }, `${me.player.emoji} You're in this game`)),
      !(multi && s.status === "lobby") && (s.mode === "teams"
        ? s.teams.map((t) => h("div", { class: "card tight team-col", style: { "--team": t.color } }, h("b", null, h("span", { class: "team-dot" }), t.name), playerChips(s, t.player_ids)))
        : h("div", { class: "card tight" }, playerChips(s))),
      !["active", "lobby", "collecting"].includes(s.status) ? h("div", { class: "card muted" }, "This game is no longer running.") : null,
      ...blocks);
  }
  draw();
  const sock = openSocket({ session: s.id, onMessage: (msg) => {
    if (msg.type !== "session" || document.querySelector(".modal-back")) return;
    const focused = document.activeElement === wordInput;
    draw(msg.session);
    if (focused) wordInput.focus();
  } });
  onLeave(() => sock.close());
  void app;
  return root;
}

// ---------------------------------------------------------------- watch / TV
export async function watchView({ params, query }) {
  let s = await api(`/api/sessions/${params[0]}`);
  const tv = query.get("tv") === "1";
  document.body.classList.toggle("tv", tv);
  onLeave(() => document.body.classList.remove("tv"));
  const root = h("div", { class: "stack watch" });
  function draw(next) {
    if (next) s = next;
    const w = s.watch || {};
    const rows = (w.scoreboard || []).slice().sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    mount(root,
      !tv && topbar("Watching", true, h("a", { class: "btn small", href: `#/watch/${s.id}?tv=1` }, "📺 TV mode")),
      h("div", { class: "center stack", style: { gap: ".3rem" } },
        h("div", { class: "watch-emoji" }, s.game.emoji),
        h("h1", { class: "logo watch-title" }, s.game.name),
        h("div", null, statusChip(s.live_status))),
      w.headline ? h("div", { class: "watch-headline center" }, w.headline) : null,
      rows.length
        ? h("div", { class: "card tight list watch-board" }, rows.map((r, i) => h("div", { class: "list-item" },
            h("span", { class: "watch-rank" }, ((rank) => ["🥇", "🥈", "🥉"][rank - 1] || rank)(rows.findIndex((x) => x.score === r.score) + 1)),
            r.color ? h("span", { class: "team-dot", style: { "--team": r.color } }) : h("span", { class: "watch-e" }, r.emoji),
            h("span", { class: "grow watch-name" }, r.name),
            h("span", { class: "watch-score" }, r.score ?? "–"))))
        : h("div", { class: "card center muted" }, s.status === "lobby" ? "Waiting for players to join…" : "Scores appear after the first round."),
      tv ? h("a", { class: "btn small ghost", href: `#/watch/${s.id}`, style: { alignSelf: "center" } }, "Exit TV mode") : null);
  }
  draw();
  const sock = openSocket({ session: s.id, onMessage: (msg) => { if (msg.type === "session") draw(msg.session); } });
  onLeave(() => sock.close());
  return root;
}

// ---------------------------------------------------------------- invite
export async function inviteView() {
  const ca = await api("/api/ca").catch(() => ({ available: false }));
  const url = (ca.app_url || location.origin).replace(/\/$/, "") + "/";
  const setup = `${(ca.setup_url || `http://${location.host}`).replace(/\/$/, "")}/setup/`;
  let tab = "join";
  const box = h("div", { class: "stack center", style: { alignItems: "center" } });
  const draw = () => mount(box,
    ca.available && seg([{ value: "join", label: "📲 Join" }, { value: "setup", label: "🔐 First time on this phone" }], tab, (v) => { tab = v; draw(); }),
    tab === "join"
      ? [
          h("p", { class: "muted", style: { margin: 0 } }, "Scan to open the games on your phone"),
          h("img", { src: `/api/qr.svg?data=${encodeURIComponent(url)}`, alt: "QR code", class: "qr" }),
          h("div", { class: "logo", style: { fontSize: "1.3rem" } }, url.replace(/^https?:\/\//, "").replace(/\/$/, "")),
          h("p", { class: "small muted", style: { maxWidth: "340px" } }, "Then pick your name. Live games show up on the home screen and under Nights."),
          ca.available && h("p", { class: "small", style: { maxWidth: "340px" } }, "Page won't open or says “not secure”? Use ", h("b", null, "🔐 First time on this phone"), " first."),
        ]
      : [
          h("p", { class: "muted", style: { margin: 0 } }, "Scan to install the home certificate (once per phone)"),
          h("img", { src: `/api/qr.svg?data=${encodeURIComponent(setup)}`, alt: "QR code", class: "qr" }),
          h("div", { class: "small muted", style: { wordBreak: "break-all" } }, setup),
          h("p", { class: "small muted", style: { maxWidth: "340px" } }, "It shows the steps for that phone. Afterwards, scan the 📲 Join code."),
        ]);
  draw();
  return h("div", { class: "stack" }, topbar("Invite", true), box);
}

export { empty };
