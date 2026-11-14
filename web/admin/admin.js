import { api } from "/static/api.js";
import { h, mount, toast, modal, confirmDialog, promptDialog, seg, switchField, fmtDate, fmtTime, ago, empty, spinner } from "/static/ui.js";
import { EMOJIS } from "/static/emoji.js";

const app = document.getElementById("app");
const TABS = [
  ["dashboard", "📊 Dashboard"], ["players", "👥 Players"], ["sessions", "🎮 Sessions"], ["nights", "🌙 Nights"],
  ["games", "🕹️ Games"], ["decks", "🃏 Decks"], ["settings", "⚙️ Settings"], ["backup", "💾 Backup"], ["audit", "📜 Audit log"],
];
const views = {};
let current = (location.hash.slice(1) || "dashboard");
const content = h("div");

const bytes = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} kB`);
const statusBadge = (s) => h("span", { class: `badge ${{ finished: "good", void: "bad", active: "info", abandoned: "warn" }[s] || ""}` }, s);

async function guarded(fn) {
  try { return await fn(); } catch (e) { toast(e.message, "bad"); throw e; }
}

// ------------------------------------------------------------ boot / auth
async function boot() {
  const status = await api("/api/admin/status");
  if (!status.enabled) {
    return mount(app, h("div", { class: "card stack", style: { marginTop: "3rem" } },
      h("h1", null, "🔒 Admin disabled"),
      h("p", { class: "muted" }, "Set the ADMIN_PASSWORD environment variable on the container (TrueNAS app → Edit) and restart it."),
      h("a", { class: "btn", href: "/" }, "← Back to games")));
  }
  if (!status.logged_in) return loginScreen();
  shell();
}

function loginScreen() {
  const pw = h("input", { type: "password", placeholder: "Admin password", autocomplete: "current-password" });
  const go = async () => {
    try {
      await api("/api/admin/login", { method: "POST", body: { password: pw.value } });
      shell();
    } catch (e) { toast(e.message, "bad"); pw.select(); }
  };
  pw.addEventListener("keydown", (e) => e.key === "Enter" && go());
  mount(app, h("div", { class: "card stack", style: { maxWidth: "380px", margin: "4rem auto" } },
    h("h1", null, "⚙️ Admin"), pw, h("button", { class: "btn primary block", onclick: go }, "Log in"),
    h("a", { href: "/", class: "small center" }, "← Back to games")));
  setTimeout(() => pw.focus(), 50);
}

function shell() {
  mount(app,
    h("div", { class: "row between" },
      h("h1", { style: { margin: 0 } }, "⚙️ Admin"),
      h("div", { class: "row" },
        h("a", { class: "btn small", href: "/" }, "← App"),
        h("button", { class: "btn small ghost", onclick: async () => { await api("/api/admin/logout", { method: "POST" }); loginScreen(); } }, "Log out"))),
    h("div", { class: "tabs" }, seg(TABS.map(([value, label]) => ({ value, label })), current, (v) => { current = v; location.hash = v; show(); })),
    content);
  show();
}

async function show() {
  mount(content, spinner());
  try {
    mount(content, await (views[current] || views.dashboard)());
  } catch (e) {
    if (e.status === 401) return loginScreen();
    mount(content, empty("😵", e.message));
  }
}
const refresh = show;

window.addEventListener("hashchange", () => {
  const tab = location.hash.slice(1);
  if (tab && tab !== current && views[tab] && document.querySelector(".tabs")) { current = tab; shell(); }
});

// ------------------------------------------------------------ dashboard
views.dashboard = async () => {
  const d = await api("/api/admin/dashboard");
  const stat = (v, l) => h("div", { class: "stat" }, h("div", { class: "v" }, v), h("div", { class: "l" }, l));
  return h("div", { class: "stack lg" },
    h("div", { class: "stat-grid" },
      stat(d.totals.players, "Players"), stat(d.totals.sessions, "Games played"), stat(d.totals.nights, "Game nights"),
      stat(d.totals.words, "Active words"), stat(bytes(d.db_size), "Database")),
    h("div", { class: "card row between" },
      h("div", null, h("b", null, "Last backup"), h("div", { class: "small muted" }, d.last_backup ? `${ago(d.last_backup.created_at)} · ${d.backup_count} kept` : "None yet")),
      h("button", { class: "btn small", onclick: async () => { await guarded(() => api("/api/admin/backups", { method: "POST" })); toast("Backup created", "good"); refresh(); } }, "Back up now")),
    d.most_played.length ? h("div", null, h("h3", null, "Most played"),
      h("div", { class: "card tight list" }, d.most_played.map((g) => h("div", { class: "list-item" }, h("b", { class: "grow" }, g.name), h("span", null, `${g.sessions} games`))))) : null,
    h("div", null, h("h3", null, "Recent sessions"), sessionTable(d.recent_sessions)));
};

// ------------------------------------------------------------ players
function emojiPicker(value, onpick) {
  let v = value;
  const custom = h("input", { value: v, placeholder: "or type/paste any emoji", style: { maxWidth: "220px" }, oninput: (e) => { v = e.target.value.trim(); onpick(v); draw(); } });
  const grid = h("div", { class: "emoji-grid" });
  const draw = () => mount(grid, EMOJIS.map((e) => h("button", { type: "button", class: e === v ? "on" : "", onclick: () => { v = e; custom.value = e; onpick(e); draw(); } }, e)));
  draw();
  return h("div", { class: "stack" }, grid, custom);
}

async function playerDialog(p) {
  const st = { name: p?.name || "", emoji: p?.emoji || EMOJIS[Math.floor(Math.random() * 40)] };
  const name = h("input", { value: st.name, placeholder: "Name", maxlength: 60, oninput: (e) => { st.name = e.target.value; } });
  return modal(p ? `Edit ${p.name}` : "Add player", h("div", { class: "stack" },
    h("label", { class: "field" }, "Name", name), h("b", { class: "small" }, "Emoji"), emojiPicker(st.emoji, (e) => { st.emoji = e; })), [
    { label: "Cancel", class: "ghost", value: null },
    { label: "Save", class: "primary", onclick: async () => {
      if (!st.name.trim()) { toast("Name is required", "bad"); return false; }
      try {
        if (p) await api(`/api/admin/players/${p.id}`, { method: "PUT", body: { name: st.name, emoji: st.emoji } });
        else await api("/api/admin/players", { method: "POST", body: { name: st.name, emoji: st.emoji } });
        toast("Saved", "good");
        return true;
      } catch (e) { toast(e.message, "bad"); return false; }
    } },
  ]);
}

views.players = async () => {
  const players = await api("/api/admin/players");
  const active = players.filter((p) => p.active);
  const archived = players.filter((p) => !p.active);
  const row = (p) => h("tr", { class: p.active ? "" : "dim" },
    h("td", { style: { fontSize: "1.5rem", width: "2.5rem" } }, p.emoji),
    h("td", null, h("b", null, p.name), h("div", { class: "tiny muted" }, p.last_played ? `last played ${ago(p.last_played)}` : "never played")),
    h("td", { class: "right" }, p.sessions),
    h("td", { class: "right nowrap" },
      h("button", { class: "btn small", onclick: async () => { if (await playerDialog(p)) refresh(); } }, "Edit"), " ",
      h("button", { class: "btn small ghost", onclick: () => playerMenu(p, players) }, "⋯")));
  return h("div", { class: "stack" },
    h("div", { class: "row wrap" },
      h("button", { class: "btn primary", onclick: async () => { if (await playerDialog(null)) refresh(); } }, "+ Add player"),
      h("button", { class: "btn", onclick: bulkDialog }, "Bulk add"),
      h("span", { class: "muted small grow right" }, `${active.length} active · ${archived.length} archived`)),
    players.length ? h("div", { class: "card tight table-wrap" }, h("table", { class: "admin" },
      h("thead", null, h("tr", null, h("th"), h("th", null, "Name"), h("th", { class: "right" }, "Games"), h("th"))),
      h("tbody", null, [...active, ...archived].map(row)))) : empty("👥", "No players yet. Add your friends!"));
};

async function playerMenu(p, players) {
  const others = players.filter((x) => x.id !== p.id);
  const sel = h("select", null, h("option", { value: "" }, "Merge into…"), others.map((o) => h("option", { value: o.id }, `${o.emoji} ${o.name}`)));
  const r = await modal(`${p.emoji} ${p.name}`, h("div", { class: "stack" },
    h("p", { class: "muted small" }, "Archived players are hidden from the people pool but keep their history. Merging moves all of this player's games onto another player and deletes this one."),
    sel), [
    p.active ? { label: "Archive", value: "archive" } : { label: "Restore", value: "restore" },
    { label: "Merge", value: "merge" },
    p.sessions === 0 && { label: "Delete", class: "danger", value: "delete" },
    { label: "Close", class: "ghost", value: null },
  ].filter(Boolean));
  if (r === "archive" || r === "restore") {
    await guarded(() => api(`/api/admin/players/${p.id}`, { method: "PUT", body: { active: r === "restore" } }));
    toast(r === "archive" ? "Archived" : "Restored", "good");
  } else if (r === "merge") {
    const into = others.find((o) => String(o.id) === sel.value);
    if (!into) return toast("Pick who to merge into", "bad");
    if (!(await confirmDialog("Merge players?", `All of ${p.name}'s games move to ${into.name}, then ${p.name} is deleted. This can't be undone.`, "Merge", true))) return;
    const res = await guarded(() => api(`/api/admin/players/${p.id}/merge`, { method: "POST", body: { into_id: into.id } }));
    toast(`Merged (${res.moved} games moved)`, "good");
  } else if (r === "delete") {
    if (!(await confirmDialog("Delete player?", `Delete ${p.name}?`, "Delete", true))) return;
    await guarded(() => api(`/api/admin/players/${p.id}`, { method: "DELETE" }));
  } else return;
  refresh();
}

async function bulkDialog() {
  const ta = h("textarea", { placeholder: "One per line, optionally with an emoji:\n🦊 Ana\nBogdan 🐻\nCata" });
  const r = await modal("Bulk add players", h("div", { class: "stack" }, ta), [
    { label: "Cancel", class: "ghost", value: null },
    { label: "Add", class: "primary", onclick: async () => {
      try { return await api("/api/admin/players/bulk", { method: "POST", body: { text: ta.value } }); } catch (e) { toast(e.message, "bad"); return false; }
    } },
  ]);
  if (r) {
    toast(`Added ${r.added.length}${r.skipped.length ? `, skipped ${r.skipped.length} existing` : ""}`, "good");
    refresh();
  }
}

// ------------------------------------------------------------ sessions
function sessionTable(items, opts = {}) {
  if (!items.length) return empty("🎮", "No sessions.");
  return h("div", { class: "card tight table-wrap" }, h("table", { class: "admin" },
    h("thead", null, h("tr", null, h("th", null, "Game"), h("th", null, "Players / winner"), h("th", null, "Status"), h("th"))),
    h("tbody", null, items.map((s) => {
      const winners = s.mode === "teams" ? s.teams.filter((t) => t.placement === 1).map((t) => t.name) : s.participants.filter((p) => p.placement === 1).map((p) => p.name);
      return h("tr", { class: s.status === "finished" ? "" : "dim" },
        h("td", null, h("span", { class: "nowrap" }, `${s.game.emoji} ${s.game.name}`), h("div", { class: "tiny muted nowrap" }, `${fmtDate(s.started_at)} ${fmtTime(s.started_at)} · ${s.mode}`)),
        h("td", null, s.participants.map((p) => p.emoji).join(""), winners.length ? h("div", { class: "tiny muted" }, `🏆 ${winners.join(", ")}`) : null),
        h("td", null, statusBadge(s.status)),
        h("td", { class: "right" }, h("button", { class: "btn small", onclick: () => sessionDialog(s.id, opts.onchange || refresh) }, "Open")));
    }))));
}

views.sessions = async () => {
  const [games, players, nights] = await Promise.all([api("/api/admin/games"), api("/api/admin/players"), api("/api/admin/nights")]);
  const f = { game_id: "", player_id: "", night_id: "", status: "", offset: 0 };
  const list = h("div");
  const pager = h("div", { class: "row between" });
  const opt = (v, l) => h("option", { value: v }, l);
  const filter = (key, options) => h("select", { onchange: (e) => { f[key] = e.target.value; f.offset = 0; load(); } }, options);
  async function load() {
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v !== "")).toString();
    const r = await api(`/api/admin/sessions?limit=50&${qs}`);
    mount(list, sessionTable(r.items, { onchange: load }));
    mount(pager,
      h("span", { class: "small muted" }, `${r.total} sessions`),
      h("div", { class: "row" },
        h("button", { class: "btn small", disabled: f.offset === 0, onclick: () => { f.offset = Math.max(0, f.offset - 50); load(); } }, "‹ Newer"),
        h("button", { class: "btn small", disabled: f.offset + 50 >= r.total, onclick: () => { f.offset += 50; load(); } }, "Older ›")));
  }
  load();
  return h("div", { class: "stack" },
    h("div", { class: "filters" },
      filter("game_id", [opt("", "All games"), games.map((g) => opt(g.id, `${g.emoji} ${g.name}`))]),
      filter("player_id", [opt("", "All players"), players.map((p) => opt(p.id, `${p.emoji} ${p.name}`))]),
      filter("night_id", [opt("", "All nights"), nights.map((n) => opt(n.id, `${n.date}${n.label ? " · " + n.label : ""}`))]),
      filter("status", [opt("", "Any status"), ["finished", "void", "active", "abandoned"].map((s) => opt(s, s))])),
    h("div", { class: "row" },
      h("button", { class: "btn small ghost", onclick: async () => {
        if (!(await confirmDialog("Clean up?", "Delete abandoned games and unfinished games older than 24 hours.", "Clean up"))) return;
        const r = await guarded(() => api("/api/admin/sessions/cleanup", { method: "POST" }));
        toast(`Deleted ${r.deleted}`, "good");
        load();
      } }, "🧹 Clean up abandoned")),
    list, pager);
};

async function sessionDialog(id, onchange) {
  const [s, players, nights] = await Promise.all([api(`/api/sessions/${id}`), api("/api/admin/players"), api("/api/admin/nights")]);
  const edit = {
    night_id: s.night.id,
    teams: s.teams.map((t) => ({ idx: t.idx, name: t.name, score: t.score })),
    participants: s.participants.map((p) => ({ player_id: p.player_id, team_idx: p.team_idx, score: p.score })),
  };
  const byId = new Map(players.map((p) => [p.id, p]));
  const body = h("div", { class: "stack" });
  const num = (v, set) => h("input", { class: "score-input", type: "number", step: "any", value: v ?? "", oninput: (e) => set(e.target.value === "" ? null : Number(e.target.value)) });

  function draw() {
    const inSession = new Set(edit.participants.map((p) => p.player_id));
    const add = h("select", { onchange: (e) => {
      const pid = Number(e.target.value);
      if (!pid) return;
      edit.participants.push({ player_id: pid, team_idx: s.mode === "teams" ? edit.teams[0].idx : null, score: null });
      draw();
    } }, h("option", { value: "" }, "+ Add player…"), players.filter((p) => !inSession.has(p.id)).map((p) => h("option", { value: p.id }, `${p.emoji} ${p.name}`)));
    mount(body,
      h("div", { class: "row wrap" }, statusBadge(s.status), h("span", { class: "small muted" }, `${s.mode} · started ${fmtDate(s.started_at)} ${fmtTime(s.started_at)}`)),
      h("label", { class: "field" }, "Game night", h("select", { onchange: (e) => { edit.night_id = Number(e.target.value); } },
        nights.map((n) => h("option", { value: n.id, selected: n.id === edit.night_id }, `${n.date}${n.label ? " · " + n.label : ""}`)))),
      s.mode === "teams" && h("div", { class: "stack" }, h("b", null, "Team scores"), edit.teams.map((t) => h("div", { class: "row" },
        h("input", { value: t.name, oninput: (e) => { t.name = e.target.value; } }), num(t.score, (v) => { t.score = v; })))),
      h("b", null, s.mode === "teams" ? "Players & teams" : "Player scores"),
      h("div", { class: "list" }, edit.participants.map((p) => h("div", { class: "list-item" },
        h("span", { style: { fontSize: "1.3rem" } }, byId.get(p.player_id)?.emoji), h("span", { class: "grow" }, byId.get(p.player_id)?.name),
        s.mode === "teams"
          ? h("select", { style: { width: "auto" }, onchange: (e) => { p.team_idx = Number(e.target.value); } }, edit.teams.map((t) => h("option", { value: t.idx, selected: t.idx === p.team_idx }, t.name)))
          : num(p.score, (v) => { p.score = v; }),
        h("button", { class: "btn small ghost icon-btn", onclick: () => { edit.participants = edit.participants.filter((x) => x !== p); draw(); } }, "✕")))),
      add,
      s.details?.summary && h("div", { class: "small muted" }, s.details.summary));
  }
  draw();
  const actions = [
    { label: "Delete", class: "danger", value: "delete" },
    s.status === "finished" && { label: "Void", value: "void" },
    s.status === "void" && { label: "Restore", value: "restore" },
    { label: "Close", class: "ghost", value: null },
    { label: "Save", class: "primary", onclick: async () => {
      try {
        await api(`/api/admin/sessions/${id}`, { method: "PUT", body: edit });
        toast("Saved & recalculated", "good");
        return "saved";
      } catch (e) { toast(e.message, "bad"); return false; }
    } },
  ].filter(Boolean);
  const r = await modal(`${s.game.emoji} ${s.game.name} #${s.id}`, body, actions);
  if (r === "delete") {
    if (!(await confirmDialog("Delete session?", "This removes it permanently. Voiding keeps it but excludes it from stats.", "Delete", true))) return;
    await guarded(() => api(`/api/admin/sessions/${id}`, { method: "DELETE" }));
  } else if (r === "void" || r === "restore") {
    await guarded(() => api(`/api/admin/sessions/${id}/${r}`, { method: "POST" }));
  } else if (r !== "saved") return;
  onchange();
}

// ------------------------------------------------------------ nights
views.nights = async () => {
  const nights = await api("/api/admin/nights");
  return h("div", { class: "stack" },
    h("p", { class: "muted small" }, "Games are grouped into nights automatically (games after midnight, until the cutoff hour, count for the previous day). Rename a night, or merge two that belong together."),
    nights.length ? h("div", { class: "card tight table-wrap" }, h("table", { class: "admin" },
      h("thead", null, h("tr", null, h("th", null, "Date"), h("th", null, "Label"), h("th", { class: "right" }, "Games"), h("th"))),
      h("tbody", null, nights.map((n) => h("tr", null,
        h("td", { class: "nowrap" }, fmtDate(n.date, { year: "numeric" })),
        h("td", null, n.label || h("span", { class: "muted" }, "–")),
        h("td", { class: "right" }, n.sessions, n.all_sessions > n.sessions ? h("span", { class: "tiny muted" }, ` (+${n.all_sessions - n.sessions})`) : null),
        h("td", { class: "right nowrap" },
          h("button", { class: "btn small", onclick: async () => {
            const label = await promptDialog("Rename night", "Label (e.g. Ana's birthday)", n.label || "");
            if (label === null || label === undefined) return;
            await guarded(() => api(`/api/admin/nights/${n.id}`, { method: "PUT", body: { label } }));
            refresh();
          } }, "Rename"), " ",
          h("button", { class: "btn small ghost", onclick: () => nightMenu(n, nights) }, "⋯"))))))) : empty("🌙", "No nights yet."));
};

async function nightMenu(n, nights) {
  const others = nights.filter((x) => x.id !== n.id);
  const sel = h("select", null, h("option", { value: "" }, "Merge into…"), others.map((o) => h("option", { value: o.id }, `${o.date}${o.label ? " · " + o.label : ""}`)));
  const date = h("input", { type: "date", value: n.date });
  const r = await modal(`Night of ${n.date}`, h("div", { class: "stack" }, h("label", { class: "field" }, "Date", date), sel), [
    n.all_sessions === 0 && { label: "Delete", class: "danger", value: "delete" },
    { label: "Merge", value: "merge" },
    { label: "Close", class: "ghost", value: null },
    { label: "Save date", class: "primary", value: "date" },
  ].filter(Boolean));
  if (r === "date") await guarded(() => api(`/api/admin/nights/${n.id}`, { method: "PUT", body: { date: date.value } }));
  else if (r === "merge") {
    if (!sel.value) return toast("Pick a night to merge into", "bad");
    await guarded(() => api(`/api/admin/nights/${n.id}/merge`, { method: "POST", body: { into_id: Number(sel.value) } }));
  } else if (r === "delete") await guarded(() => api(`/api/admin/nights/${n.id}`, { method: "DELETE" }));
  else return;
  refresh();
}

// ------------------------------------------------------------ games
function settingsForm(schema, values, decks) {
  return h("div", { class: "stack" }, schema.map((f) => {
    const set = (v) => { values[f.key] = v; };
    if (f.type === "bool") return switchField(f.label, !!values[f.key], set, f.help);
    if (f.type === "select") return h("div", { class: "stack", style: { gap: ".3rem" } }, h("b", { class: "small" }, f.label),
      seg(f.options.map((o) => (typeof o === "object" ? o : { value: o, label: String(o) })), values[f.key], set));
    if (f.type === "number") return h("label", { class: "field" }, f.label, h("input", { type: "number", value: values[f.key], onchange: (e) => set(Number(e.target.value)) }));
    if (f.type === "decks") {
      const chosen = new Set(values[f.key] || []);
      const wrap = h("div", { class: "chips" });
      const draw = () => mount(wrap, decks.filter((d) => d.enabled).map((d) => h("span", { class: `chip sm ${chosen.has(d.id) ? "on" : ""}`, onclick: () => {
        chosen.has(d.id) ? chosen.delete(d.id) : chosen.add(d.id); set([...chosen]); draw();
      } }, h("span", { class: "e" }, d.emoji), d.name)));
      draw();
      return h("div", { class: "stack", style: { gap: ".3rem" } }, h("b", { class: "small" }, `${f.label} (none = all)`), wrap);
    }
    return null;
  }));
}

views.games = async () => {
  const games = await api("/api/admin/games");
  const move = async (i, d) => {
    const ids = games.map((g) => g.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    await api("/api/admin/games/order", { method: "POST", body: { ids } });
    refresh();
  };
  return h("div", { class: "stack" },
    h("div", { class: "row between" }, h("p", { class: "muted small", style: { margin: 0 } }, "Games come from folders in games/. Defaults set here are pre-selected when starting a game."),
      h("button", { class: "btn small", onclick: async () => { const r = await guarded(() => api("/api/admin/games/reload", { method: "POST" })); toast(`Reloaded: ${r.games.join(", ")}`, "good"); refresh(); } }, "↻ Reload from disk")),
    games.map((g, i) => h("div", { class: "card stack" },
      h("div", { class: "row between" },
        h("div", { class: "row" }, h("span", { style: { fontSize: "2rem" } }, g.emoji),
          h("div", null, h("b", null, g.name), h("div", { class: "tiny muted" }, `${g.sessions} games played${g.installed ? "" : " · folder missing!"}`))),
        h("div", { class: "row" },
          h("button", { class: "btn small icon-btn", disabled: i === 0, onclick: () => move(i, -1) }, "↑"),
          h("button", { class: "btn small icon-btn", disabled: i === games.length - 1, onclick: () => move(i, 1) }, "↓"))),
      switchField("Enabled", g.enabled, async (v) => { await guarded(() => api(`/api/admin/games/${g.id}`, { method: "PUT", body: { enabled: v } })); toast(v ? "Enabled" : "Disabled", "good"); }),
      g.settings_schema.length ? h("button", { class: "btn small", onclick: () => gameDefaultsDialog(g) }, "Default settings…") : null)));
};

async function gameDefaultsDialog(g) {
  const decks = g.has_decks ? await api(`/api/admin/decks?game_id=${g.id}`) : [];
  const values = { ...g.defaults };
  const r = await modal(`${g.emoji} ${g.name} defaults`, settingsForm(g.settings_schema, values, decks), [
    { label: "Reset", class: "ghost", value: "reset" },
    { label: "Cancel", class: "ghost", value: null },
    { label: "Save", class: "primary", value: "save" },
  ]);
  if (!r) return;
  await guarded(() => api(`/api/admin/games/${g.id}`, { method: "PUT", body: { settings: r === "reset" ? {} : values } }));
  toast("Defaults saved", "good");
  refresh();
}

// ------------------------------------------------------------ decks
views.decks = async () => {
  const games = (await api("/api/admin/games")).filter((g) => g.has_decks);
  if (!games.length) return empty("🃏", "No installed game uses decks.");
  const [decks, hardest] = await Promise.all([api("/api/admin/decks"), api("/api/admin/words/stats?limit=15")]);
  return h("div", { class: "stack lg" },
    games.map((g) => h("div", { class: "stack" },
      h("div", { class: "row between" }, h("h2", { style: { margin: 0 } }, `${g.emoji} ${g.name}`),
        h("button", { class: "btn primary small", onclick: () => newDeckDialog(g) }, "+ Custom deck")),
      h("div", { class: "card tight table-wrap" }, h("table", { class: "admin" },
        h("thead", null, h("tr", null, h("th"), h("th", null, "Deck"), h("th", { class: "right" }, "Words"), h("th", null, "On"), h("th"))),
        h("tbody", null, decks.filter((d) => d.game_id === g.id).map((d) => h("tr", { class: d.enabled ? "" : "dim" },
          h("td", { style: { fontSize: "1.4rem", width: "2.4rem" } }, d.emoji),
          h("td", null, h("b", null, d.name), " ", h("span", { class: `badge ${d.builtin ? "" : "info"}` }, d.builtin ? "built-in" : "custom"), h("div", { class: "tiny muted" }, d.description)),
          h("td", { class: "right" }, d.word_count, d.total_words > d.word_count ? h("span", { class: "tiny muted" }, `/${d.total_words}`) : null),
          h("td", null, h("input", { type: "checkbox", checked: d.enabled, style: { width: "22px", minHeight: "22px" }, onchange: async (e) => { await guarded(() => api(`/api/admin/decks/${d.id}`, { method: "PUT", body: { enabled: e.target.checked } })); refresh(); } })),
          h("td", { class: "right" }, h("button", { class: "btn small", onclick: () => deckDialog(d.id) }, "Words")))))))) ),
    hardest.length ? h("div", null, h("h3", null, "😈 Hardest words"), h("div", { class: "card tight table-wrap" }, h("table", { class: "admin" },
      h("thead", null, h("tr", null, h("th", null, "Word"), h("th", null, "Deck"), h("th", { class: "right" }, "Shown"), h("th", { class: "right" }, "Guessed"))),
      h("tbody", null, hardest.map((w) => h("tr", null, h("td", null, w.text), h("td", { class: "muted" }, w.deck), h("td", { class: "right" }, w.shown), h("td", { class: "right" }, `${w.correct_rate}%`))))))) : null);
};

async function newDeckDialog(g) {
  const st = { name: "", emoji: "🃏", description: "", words: "" };
  const r = await modal("New custom deck", h("div", { class: "stack" },
    h("label", { class: "field" }, "Name", h("input", { placeholder: "Inside jokes", oninput: (e) => { st.name = e.target.value; } })),
    h("label", { class: "field" }, "Emoji", h("input", { value: st.emoji, oninput: (e) => { st.emoji = e.target.value; } })),
    h("label", { class: "field" }, "Description", h("input", { oninput: (e) => { st.description = e.target.value; } })),
    h("label", { class: "field" }, "Words", h("span", { class: "help" }, "One per line (or comma-separated)"), h("textarea", { oninput: (e) => { st.words = e.target.value; } }))), [
    { label: "Cancel", class: "ghost", value: null },
    { label: "Create", class: "primary", onclick: async () => {
      try { return await api("/api/admin/decks", { method: "POST", body: { game_id: g.id, ...st } }); } catch (e) { toast(e.message, "bad"); return false; }
    } },
  ]);
  if (r) { toast(`Created with ${r.word_count} words`, "good"); refresh(); }
}

async function deckDialog(id) {
  let d = await api(`/api/admin/decks/${id}`);
  let filter = "";
  let changed = false;
  const list = h("div", { class: "word-list list" });
  const head = h("div", { class: "small muted" });
  function draw() {
    head.textContent = `${d.word_count} active of ${d.total_words} words${d.builtin ? " · built-in words can be turned off but are edited in the repo" : ""}`;
    const words = d.words.filter((w) => w.text.toLowerCase().includes(filter.toLowerCase()));
    mount(list, words.map((w) => h("div", { class: "list-item" },
      h("input", { type: "checkbox", checked: w.active, style: { width: "22px", minHeight: "22px" }, onchange: async (e) => {
        await guarded(() => api(`/api/admin/words/${w.id}`, { method: "PUT", body: { active: e.target.checked } }));
        w.active = e.target.checked; changed = true;
        d.word_count += w.active ? 1 : -1; draw();
      } }),
      h("span", { class: "grow", style: { opacity: w.active ? 1 : 0.5 } }, w.text),
      h("span", { class: "tiny muted nowrap" }, w.shown ? `${w.correct_rate}% of ${w.shown}` : ""),
      !d.builtin && h("button", { class: "btn small ghost icon-btn", onclick: async () => {
        await guarded(() => api(`/api/admin/words/${w.id}`, { method: "DELETE" }));
        d = await api(`/api/admin/decks/${id}`); changed = true; draw();
      } }, "🗑"))));
  }
  draw();
  const addBox = h("textarea", { placeholder: "Add words: one per line", style: { minHeight: "80px" } });
  const body = h("div", { class: "stack" }, head,
    h("input", { type: "search", placeholder: "Filter…", oninput: (e) => { filter = e.target.value; draw(); } }),
    list,
    !d.builtin && h("div", { class: "stack" }, addBox, h("button", { class: "btn", onclick: async () => {
      const r = await guarded(() => api(`/api/admin/decks/${id}/words`, { method: "POST", body: { text: addBox.value } }));
      d = r.deck; addBox.value = ""; changed = true; draw(); toast(`Added ${r.added}`, "good");
    } }, "Add words")));
  const r = await modal(`${d.emoji} ${d.name}`, body, [
    !d.builtin && { label: "Delete deck", class: "danger", value: "delete" },
    !d.builtin && { label: "Rename", value: "rename" },
    { label: "Done", class: "primary", value: null },
  ].filter(Boolean));
  if (r === "delete") {
    if (!(await confirmDialog("Delete deck?", `Delete "${d.name}" and its ${d.total_words} words?`, "Delete", true))) return;
    await guarded(() => api(`/api/admin/decks/${id}`, { method: "DELETE" }));
    changed = true;
  } else if (r === "rename") {
    const name = await promptDialog("Rename deck", "Name", d.name);
    if (name) { await guarded(() => api(`/api/admin/decks/${id}`, { method: "PUT", body: { name } })); changed = true; }
  }
  if (changed) refresh();
}

// ------------------------------------------------------------ settings
views.settings = async () => {
  const s = await api("/api/admin/settings");
  const v = { ...s.values };
  const zones = (Intl.supportedValuesOf?.("timeZone") || [v.timezone]);
  return h("div", { class: "stack lg" },
    h("div", { class: "card stack" },
      h("h3", { style: { margin: 0 } }, "General"),
      h("label", { class: "field" }, "Site name", h("input", { value: v.site_name, oninput: (e) => { v.site_name = e.target.value; } })),
      h("label", { class: "field" }, "Timezone", h("select", { onchange: (e) => { v.timezone = e.target.value; } },
        (zones.includes(v.timezone) ? zones : [v.timezone, ...zones]).map((z) => h("option", { value: z, selected: z === v.timezone }, z)))),
      h("label", { class: "field" }, "Night cutoff hour", h("span", { class: "help" }, "Games before this hour count for the previous night (e.g. 6 → 1am Sunday is still Saturday night)"),
        h("input", { type: "number", min: 0, max: 12, value: v.night_cutoff_hour, oninput: (e) => { v.night_cutoff_hour = Number(e.target.value); } }))),
    h("div", { class: "card stack" },
      h("h3", { style: { margin: 0 } }, "Scoring"),
      h("div", { class: "stack" }, Object.entries(s.formulas).map(([key, label]) => h("label", { class: "row", style: { cursor: "pointer", alignItems: "flex-start" } },
        h("input", { type: "radio", name: "formula", checked: v.scoring_formula === key, style: { width: "20px", minHeight: "20px" }, onchange: () => { v.scoring_formula = key; } }),
        h("span", null, label)))),
      h("label", { class: "field" }, "Minimum games to be ranked", h("span", { class: "help" }, "On month/year/all-time leaderboards (tonight always ranks everyone)"),
        h("input", { type: "number", min: 1, max: 100, value: v.min_sessions, oninput: (e) => { v.min_sessions = Number(e.target.value); } })),
      h("button", { class: "btn small", onclick: async () => {
        const r = await guarded(() => api("/api/admin/recompute", { method: "POST" }));
        toast(`Recalculated ${r.sessions} games`, "good");
      } }, "↻ Recalculate all points")),
    h("button", { class: "btn primary", onclick: async () => {
      await guarded(() => api("/api/admin/settings", { method: "PUT", body: v }));
      toast("Settings saved", "good");
    } }, "Save settings"),
    h("div", { class: "card small muted" },
      h("b", null, "Container environment"), h("br"),
      `Data dir: ${s.environment.data_dir} · auto backup: ${s.environment.auto_backup ? "on" : "off"} · keep ${s.environment.backup_keep} backups`));
};

// ------------------------------------------------------------ backup
views.backup = async () => {
  const backups = await api("/api/admin/backups");
  const file = h("input", { type: "file", accept: ".json,application/json" });
  return h("div", { class: "stack lg" },
    h("div", { class: "card stack" },
      h("h3", { style: { margin: 0 } }, "Backups"),
      h("p", { class: "small muted" }, "A database copy is made automatically every 24h into /data/backups (on your TrueNAS dataset, so ZFS snapshots cover it too)."),
      h("div", { class: "row wrap" },
        h("button", { class: "btn primary", onclick: async () => { await guarded(() => api("/api/admin/backups", { method: "POST" })); toast("Backup created", "good"); refresh(); } }, "Back up now"),
        h("a", { class: "btn", href: "/api/admin/export" }, "⬇ Export JSON")),
      backups.length ? h("div", { class: "list" }, backups.map((b) => h("div", { class: "list-item" },
        h("span", { class: "grow" }, b.name, h("div", { class: "tiny muted" }, `${ago(b.created_at)} · ${bytes(b.size)}`)),
        h("a", { class: "btn small", href: `/api/admin/backups/${encodeURIComponent(b.name)}` }, "⬇")))) : h("p", { class: "muted" }, "No backups yet.")),
    h("div", { class: "card stack" },
      h("h3", { style: { margin: 0 } }, "Import"),
      h("p", { class: "small muted" }, "Replaces ALL data with a JSON export. A backup of the current data is made first."),
      file,
      h("button", { class: "btn danger", onclick: async () => {
        if (!file.files[0]) return toast("Pick an export file first", "bad");
        if (!(await confirmDialog("Replace all data?", "Everything in the database is replaced by the file's content.", "Import", true))) return;
        const fd = new FormData();
        fd.append("file", file.files[0]);
        await guarded(() => api("/api/admin/import", { method: "POST", body: fd }));
        toast("Imported", "good");
        refresh();
      } }, "Import")));
};

// ------------------------------------------------------------ audit
views.audit = async () => {
  const r = await api("/api/admin/audit?limit=200");
  if (!r.items.length) return empty("📜", "Nothing yet.");
  return h("div", { class: "card tight table-wrap" }, h("table", { class: "admin" },
    h("thead", null, h("tr", null, h("th", null, "When"), h("th", null, "Action"), h("th", null, "Details"))),
    h("tbody", null, r.items.map((a) => h("tr", null,
      h("td", { class: "nowrap" }, fmtDate(a.at), h("div", { class: "tiny muted" }, fmtTime(a.at))),
      h("td", null, h("b", null, a.action), " ", a.entity, a.entity_id ? ` #${a.entity_id}` : ""),
      h("td", { class: "tiny muted", style: { wordBreak: "break-word" } }, a.detail ? JSON.stringify(a.detail) : ""))))));
};

boot();
