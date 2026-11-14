import { api } from "/static/api.js";
import { h, mount, toast, ago, seg, switchField, promptDialog, confirmDialog } from "/static/ui.js";
import { topbar } from "./components.js";

const TEAM_COLORS = ["#d9452b", "#3d8fd6", "#f5c518", "#1fa35b", "#a26be0", "#e8892b"];
const TEAM_NAMES = ["Red", "Blue", "Yellow", "Green", "Purple", "Orange"];

const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

function shuffle(a) {
  const arr = a.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export async function playView({ params, query, app }) {
  const gameId = params[0];
  const fromId = query.get("from");
  const [game, players, lineups, crews, from] = await Promise.all([
    api(`/api/games/${gameId}`),
    api("/api/players"),
    api(`/api/games/${gameId}/lineups`),
    api("/api/crews"),
    fromId ? api(`/api/sessions/${fromId}`).catch(() => null) : null,
  ]);
  const byId = new Map(players.map((p) => [p.id, p]));
  let ratings = null;

  const saved = lsGet(`gc.settings.${gameId}`) || {};
  const st = {
    mode: game.modes[0],
    selected: [], // ordered player ids
    teams: [], // [{name, color, player_ids}]
    teamCount: Math.max(2, game.teams.min),
    settings: { ...game.defaults, ...pick(saved, Object.keys(game.defaults)) },
    search: "",
    crews,
  };

  function pick(obj, keys) { return Object.fromEntries(Object.entries(obj).filter(([k]) => keys.includes(k))); }
  function setTeams(count) {
    st.teamCount = Math.min(Math.max(count, game.teams.min), game.teams.max);
    const old = st.teams;
    st.teams = Array.from({ length: st.teamCount }, (_, i) => ({
      name: old[i]?.name || TEAM_NAMES[i], color: old[i]?.color || TEAM_COLORS[i], player_ids: [],
    }));
    st.selected.forEach((pid, i) => st.teams[i % st.teamCount].player_ids.push(pid));
  }
  function loadLineup(l) {
    const ids = l.player_ids.filter((id) => byId.has(id));
    st.selected = ids;
    if (l.mode && game.modes.includes(l.mode)) st.mode = l.mode;
    if (l.teams && st.mode === "teams") {
      st.teamCount = l.teams.length;
      st.teams = l.teams.map((t, i) => ({ name: t.name || TEAM_NAMES[i], color: t.color || TEAM_COLORS[i], player_ids: t.player_ids.filter((id) => byId.has(id)) }));
    } else if (st.mode === "teams") setTeams(st.teamCount);
    if (l.settings) st.settings = { ...st.settings, ...pick(l.settings, Object.keys(game.defaults)) };
  }
  function toggle(pid) {
    const i = st.selected.indexOf(pid);
    if (i >= 0) {
      st.selected.splice(i, 1);
      st.teams.forEach((t) => { t.player_ids = t.player_ids.filter((x) => x !== pid); });
    } else {
      if (st.selected.length >= game.max_players) return toast(`Max ${game.max_players} players`, "bad");
      st.selected.push(pid);
      if (st.mode === "teams") {
        if (!st.teams.length) setTeams(st.teamCount);
        else st.teams.reduce((a, b) => (b.player_ids.length < a.player_ids.length ? b : a)).player_ids.push(pid);
      }
    }
  }
  async function balance() {
    ratings ||= await api(`/api/games/${gameId}/ratings`);
    const sorted = shuffle(st.selected).sort((a, b) => (ratings[b] ?? 50) - (ratings[a] ?? 50));
    st.teams.forEach((t) => { t.player_ids = []; });
    // snake draft: 0,1,2,2,1,0,...
    sorted.forEach((pid, i) => {
      const round = Math.floor(i / st.teamCount);
      const pos = i % st.teamCount;
      st.teams[round % 2 === 0 ? pos : st.teamCount - 1 - pos].player_ids.push(pid);
    });
  }

  if (from) loadLineup({ mode: from.mode, player_ids: from.participants.map((p) => p.player_id), teams: from.mode === "teams" ? from.teams : null, settings: from.settings });
  if (st.mode === "teams" && !st.teams.length) setTeams(st.teamCount);

  const root = h("div");
  app.classList.add("has-actionbar");

  function validation() {
    const n = st.selected.length;
    if (n < game.min_players) return `Pick at least ${game.min_players} players`;
    if (st.mode === "teams" && st.teams.some((t) => !t.player_ids.length)) return "Every team needs a player";
    const minSize = game.teams.min_size || 1;
    if (st.mode === "teams" && st.teams.some((t) => t.player_ids.length < minSize)) return `Every team needs ${minSize}+ players`;
    return null;
  }

  async function start(btn) {
    btn.disabled = true;
    lsSet(`gc.settings.${gameId}`, st.settings);
    try {
      const body = { game_id: gameId, mode: st.mode, player_ids: st.selected, settings: st.settings };
      if (st.mode === "teams") body.teams = st.teams;
      const s = await api("/api/sessions", { method: "POST", body });
      location.href = s.game.url;
    } catch (e) {
      toast(e.message, "bad");
      btn.disabled = false;
    }
  }

  function chip(p, { onclick, on = false, sm = false } = {}) {
    return h("span", { class: `chip ${on ? "on" : ""} ${sm ? "sm" : ""}`, onclick }, h("span", { class: "e" }, p.emoji), p.name);
  }

  function renderLineups() {
    const cards = [
      ...lineups.map((l, i) => ({ l, title: i === 0 ? "Last lineup" : ago(l.date), sub: l.mode === "teams" ? `${l.teams.length} teams` : null })),
      ...st.crews.map((c) => ({ l: { player_ids: c.player_ids }, title: `⭐ ${c.name}`, crew: c })),
    ];
    if (!cards.length) return null;
    return h("div", null,
      h("div", { class: "section-title" }, h("h2", null, "Quick load")),
      h("div", { class: "hscroll" }, cards.map(({ l, title, sub, crew }) => h("div", { class: "card tight click lineup-card", onclick: () => { loadLineup(l); render(); toast("Lineup loaded"); } },
        h("div", { class: "row between" }, h("b", null, title),
          crew ? h("button", { class: "btn small ghost icon-btn", style: { width: "30px", height: "30px", minHeight: "30px" }, onclick: async (e) => {
            e.stopPropagation();
            if (await confirmDialog("Delete crew?", `Remove the saved crew "${crew.name}"?`, "Delete", true)) {
              await api(`/api/crews/${crew.id}`, { method: "DELETE" });
              st.crews = st.crews.filter((c) => c.id !== crew.id);
              render();
            }
          } }, "✕") : h("span", { class: "small muted" }, `${l.player_ids.length} 👤`)),
        h("div", { class: "emojis" }, l.player_ids.map((id) => byId.get(id)?.emoji || "").join("")),
        h("div", { class: "small muted" }, sub || l.player_ids.map((id) => byId.get(id)?.name).filter(Boolean).slice(0, 4).join(", ") + (l.player_ids.length > 4 ? "…" : ""))))));
  }

  function renderSelected() {
    if (st.mode === "teams") {
      return h("div", null,
        h("div", { class: "section-title" }, h("h2", null, `Teams · ${st.selected.length} players`),
          h("div", { class: "row" },
            h("button", { class: "btn small icon-btn", disabled: st.teamCount <= game.teams.min, onclick: () => { setTeams(st.teamCount - 1); render(); } }, "−"),
            h("b", null, st.teamCount),
            h("button", { class: "btn small icon-btn", disabled: st.teamCount >= game.teams.max, onclick: () => { setTeams(st.teamCount + 1); render(); } }, "+"))),
        h("div", { class: "row wrap", style: { marginBottom: ".6rem" } },
          h("button", { class: "btn small", disabled: !st.selected.length, onclick: async () => { await balance(); render(); toast("Balanced by skill ⚖️"); } }, "⚖️ Balance"),
          h("button", { class: "btn small", disabled: !st.selected.length, onclick: () => { st.selected = shuffle(st.selected); setTeams(st.teamCount); render(); } }, "🔀 Shuffle"),
          h("span", { class: "small muted" }, "Tap a player to move them")),
        h("div", { class: "grid-2" }, st.teams.map((t, ti) => h("div", { class: "card tight team-col", style: { "--team": t.color } },
          h("h3", null, h("span", { style: { cursor: "pointer" }, onclick: async () => {
            const name = await promptDialog("Team name", "Name", t.name);
            if (name) { t.name = name.slice(0, 40); render(); }
          } }, h("span", { class: "team-dot" }), t.name, " ✎"), h("span", { class: "small muted" }, t.player_ids.length)),
          h("div", { class: "chips" }, t.player_ids.map((pid) => chip(byId.get(pid), { sm: true, onclick: () => {
            t.player_ids = t.player_ids.filter((x) => x !== pid);
            st.teams[(ti + 1) % st.teams.length].player_ids.push(pid);
            render();
          } })))))));
    }
    return h("div", null,
      h("div", { class: "section-title" }, h("h2", null, `Playing · ${st.selected.length}`),
        st.selected.length ? h("div", { class: "row" },
          h("button", { class: "btn small ghost", onclick: async () => {
            const name = await promptDialog("Save as crew", "Crew name", "");
            if (!name) return;
            const c = await api("/api/crews", { method: "POST", body: { name, player_ids: st.selected } });
            st.crews = [...st.crews.filter((x) => x.id !== c.id), c];
            toast("Crew saved ⭐", "good");
            render();
          } }, "⭐ Save"),
          h("button", { class: "btn small ghost", onclick: () => { st.selected = []; render(); } }, "Clear")) : null),
      st.selected.length
        ? h("div", { class: "chips" }, st.selected.map((pid, i) => chip(byId.get(pid), { on: true, onclick: () => { toggle(pid); render(); } })))
        : h("p", { class: "muted small" }, "Tap people below to add them. Order = turn order."));
  }

  function renderPool() {
    const q = st.search.trim().toLowerCase();
    const pool = players.filter((p) => !q || p.name.toLowerCase().includes(q));
    const search = h("input", { placeholder: `Search ${players.length} people…`, value: st.search, oninput: (e) => {
      st.search = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const el = root.querySelector("#pool-search");
      el.focus(); el.setSelectionRange(pos, pos);
    }, id: "pool-search", type: "search", autocomplete: "off" });
    return h("div", null,
      h("div", { class: "section-title" }, h("h2", null, "People")),
      h("div", { class: "stack" }, search,
        pool.length
          ? h("div", { class: "chips", id: "pool" }, pool.map((p) => chip(p, { on: st.selected.includes(p.id), onclick: () => { toggle(p.id); render(); } })))
          : h("p", { class: "muted small" }, players.length ? "Nobody matches." : "No people yet: add them in the admin dashboard (⚙️).")));
  }

  function renderSettings() {
    const schema = game.settings_schema || [];
    if (!schema.length) return null;
    return h("div", null,
      h("div", { class: "section-title" }, h("h2", null, "Settings")),
      h("div", { class: "card stack" }, schema.map((f) => {
        const value = st.settings[f.key];
        const set = (v) => { st.settings[f.key] = v; };
        if (f.type === "bool") return switchField(f.label, !!value, set, f.help);
        if (f.type === "select") return h("div", { class: "stack", style: { gap: ".35rem" } },
          h("b", { class: "small" }, f.label), seg(f.options.map((o) => (typeof o === "object" ? o : { value: o, label: String(o) })), value, set),
          f.help && h("div", { class: "tiny muted" }, f.help));
        if (f.type === "number") return h("label", { class: "field" }, f.label, h("input", { type: "number", value, min: f.min, max: f.max, onchange: (e) => set(Number(e.target.value)) }));
        if (f.type === "decks") {
          const chosen = new Set(value || []);
          const decks = game.decks || [];
          const wrap = h("div", { class: "chips" });
          const draw = () => mount(wrap, decks.map((d) => h("span", { class: `chip sm ${chosen.has(d.id) ? "on" : ""}`, onclick: () => {
            chosen.has(d.id) ? chosen.delete(d.id) : chosen.add(d.id);
            set([...chosen]); draw(); label.textContent = chosen.size ? `${chosen.size} selected` : "All decks";
          } }, h("span", { class: "e" }, d.emoji), d.name, h("span", { class: "muted tiny" }, d.word_count))));
          const label = h("span", { class: "small muted" }, chosen.size ? `${chosen.size} selected` : "All decks");
          draw();
          return h("div", { class: "stack", style: { gap: ".4rem" } }, h("div", { class: "row between" }, h("b", { class: "small" }, f.label), label), wrap,
            f.help && h("div", { class: "tiny muted" }, f.help));
        }
        return null;
      })));
  }

  function render() {
    const err = validation();
    const startBtn = h("button", { class: "btn primary xl block", disabled: !!err, onclick: (e) => start(e.currentTarget) },
      err || `Start ${game.emoji} ${game.name}`);
    mount(root,
      topbar(`${game.emoji} ${game.name}`, "/"),
      game.modes.length > 1 && h("div", { class: "row between" },
        seg(game.modes.map((m) => ({ value: m, label: m === "teams" ? "👥 Teams" : "🙋 Solo" })), st.mode, (m) => {
          st.mode = m;
          if (m === "teams") setTeams(st.teamCount);
          render();
        })),
      renderLineups(),
      renderSelected(),
      renderPool(),
      renderSettings(),
      h("div", { class: "actionbar" }, h("div", null, startBtn)));
  }
  render();
  return root;
}
