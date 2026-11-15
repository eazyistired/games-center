import { api } from "/static/api.js";
import { h, mount, seg, fmtNum, fmtDate, medal, empty, ago } from "/static/ui.js";
import { store, go } from "../app.js";
import { topbar, boardTable, podium } from "./components.js";
import { me, chooseMe, claimName, liveCard, statusChip } from "./live.js";
import { awardCards } from "./tv.js";

const PERIODS = [
  { value: "tonight", label: "Tonight" }, { value: "month", label: "Month" },
  { value: "year", label: "Year" }, { value: "all", label: "All time" },
];

export async function boardsView({ query }) {
  const games = await store.games();
  let period = query.get("period") || "all";
  let gameId = query.get("game") || "";
  const body = h("div");

  async function load() {
    history.replaceState(null, "", `#/boards?period=${period}${gameId ? `&game=${gameId}` : ""}`);
    mount(body, h("div", { class: "spinner" }));
    const data = await api(`/api/leaderboards?period=${period}${gameId ? `&game_id=${gameId}` : ""}`);
    const e = data.entries;
    const qualified = e.filter((x) => x.qualified);
    mount(body,
      e.length ? [
        podium(qualified.map((x) => ({ emoji: x.player.emoji, name: x.player.name, placement: x.rank, sub: `${fmtNum(x.avg_points)} avg` }))),
        h("div", { class: "card tight" }, boardTable(e, { variant: gameId ? "game" : "overall", minSessions: data.min_sessions })),
        h("p", { class: "tiny muted" }, "Avg = average placement points per game (winner 100, last 0). W = wins, GP = games played."),
      ] : empty("🏆", "No finished games in this period yet."));
  }

  const view = h("div", { class: "stack" },
    topbar("Leaderboards", null, h("a", { class: "btn small", href: "#/hall" }, "🏛 Hall of fame")),
    seg(PERIODS, period, (v) => { period = v; load(); }),
    games.length > 0 && seg([{ value: "", label: "🌐 Overall" }, ...games.map((g) => ({ value: g.id, label: `${g.emoji} ${g.name}` }))], gameId, (v) => { gameId = v; load(); }),
    body);
  load();
  return view;
}

export async function nightsView() {
  const nights = await api("/api/nights");
  return h("div", { class: "stack" },
    topbar("Game nights", null, h("a", { class: "btn small", href: "#/tv" }, "📺 Tonight on TV")),
    nights.length ? nights.map((n) => h("div", { class: "card click", onclick: () => go(`/nights/${n.id}`) },
      h("div", { class: "row between" },
        h("div", null, h("h3", { style: { margin: 0 } }, n.label || fmtDate(n.date, { year: "numeric" })),
          n.label && h("div", { class: "small muted" }, fmtDate(n.date, { year: "numeric" }))),
        h("div", { style: { fontSize: "1.4rem" } }, n.games.map((g) => g.emoji).join(""))),
      h("div", { class: "row between", style: { marginTop: ".5rem" } },
        h("div", { class: "small muted" }, `${n.session_count} games · ${n.player_count} players`, n.live_count ? " · " : "", n.live_count ? h("b", { style: { color: "#3ccf7f" } }, `${n.live_count} live`) : null),
        h("div", { class: "row" }, n.top.map((e, i) => h("span", { title: e.player.name }, medal(i + 1), e.player.emoji))))))
      : empty("🌙", "No game nights yet. Go play something!"));
}

export async function nightView({ params }) {
  const n = await api(`/api/nights/${params[0]}`);
  const standings = n.standings.slice().sort((a, b) => b.total_points - a.total_points);
  return h("div", { class: "stack" },
    topbar(n.label || fmtDate(n.date), "/nights", h("a", { class: "btn small", href: `#/tv?night=${n.id}` }, "📺 TV")),
    h("div", { class: "muted small" }, `${fmtDate(n.date, { year: "numeric" })} · ${n.session_count} games · ${n.player_count} players`),
    podium(standings.map((e) => ({ emoji: e.player.emoji, name: e.player.name, sub: `${fmtNum(e.total_points)} pts` }))),
    standings.length ? h("div", { class: "card tight" }, boardTable(n.standings, { variant: "night" })) : null,
    n.awards?.length ? h("div", null, h("div", { class: "section-title" }, h("h2", null, "🏅 Awards")), awardCards(n.awards)) : null,
    n.sessions.some((s) => s.status === "active") ? h("div", null,
      h("div", { class: "section-title" }, h("h2", null, h("span", { class: "live-dot" }), "Live now")),
      h("div", { class: "stack" }, n.sessions.filter((s) => s.status === "active").map(liveCard))) : null,
    h("div", { class: "section-title" }, h("h2", null, "Games played")),
    !n.sessions.some((s) => s.status === "finished") ? h("p", { class: "muted small" }, "No finished games yet.") : null,
    h("div", { class: "card tight list" }, n.sessions.filter((s) => s.status === "finished").map((s) => {
      const winners = s.mode === "teams"
        ? s.teams.filter((t) => t.placement === 1).map((t) => `${t.name} (${t.player_ids.map((id) => s.participants.find((p) => p.player_id === id)?.emoji).join("")})`)
        : s.participants.filter((p) => p.placement === 1).map((p) => `${p.emoji} ${p.name}`);
      return h("div", { class: "list-item click", onclick: () => go(`/results/${s.id}`) },
        h("span", { class: "avatar" }, s.game.emoji),
        h("div", { class: "grow" }, h("b", null, s.game.name), h("div", { class: "small muted" }, `🏆 ${winners.join(", ") || "–"}`)),
        h("div", { class: "right" }, statusChip(s.status), h("div", { class: "tiny muted" }, new Date(s.finished_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }))));
    })));
}

export async function playersView() {
  const [players, board] = await Promise.all([store.players(), api("/api/leaderboards?period=all")]);
  const stats = new Map(board.entries.map((e) => [e.player.id, e]));
  const q = { v: "" };
  const list = h("div", { class: "card tight list" });
  const draw = () => mount(list, players.filter((p) => p.name.toLowerCase().includes(q.v.toLowerCase())).map((p) => {
    const s = stats.get(p.id);
    return h("div", { class: "list-item click", onclick: () => go(`/players/${p.id}`) },
      h("span", { class: "avatar" }, p.emoji), h("b", { class: "grow" }, p.name),
      h("span", { class: "small muted" }, s ? `${s.sessions} games · ${s.wins} wins` : "no games yet"));
  }));
  draw();
  return h("div", { class: "stack" }, topbar("People"),
    players.length ? [h("input", { type: "search", placeholder: "Search…", oninput: (e) => { q.v = e.target.value; draw(); } }), list]
      : empty("👥", "No people yet. Add them in the admin dashboard."));
}

export async function playerView({ params }) {
  const d = await api(`/api/players/${params[0]}/profile`);
  const o = d.overall;
  const stat = (v, l) => h("div", { class: "stat" }, h("div", { class: "v" }, v), h("div", { class: "l" }, l));
  return h("div", { class: "stack" },
    topbar("", true),
    h("div", { class: "center stack", style: { alignItems: "center", gap: ".4rem" } },
      h("div", { class: "avatar lg" }, d.player.emoji), h("h1", { style: { margin: 0 } }, d.player.name),
      !d.player.active && h("span", { class: "badge" }, "archived"),
      me.player?.id === d.player.id
        ? h("button", { class: "me-chip", onclick: () => chooseMe() }, "📱 This phone is you ✓")
        : d.player.active && h("button", { class: "me-chip", onclick: () => claimName(d.player.id) }, "📱 This is me")),
    o ? h("div", { class: "stat-grid" },
      stat(o.sessions, "Games"), stat(o.wins, "Wins"), stat(o.win_rate == null ? "–" : `${o.win_rate}%`, "Win rate"),
      stat(fmtNum(o.avg_points), "Avg points"), stat(o.podiums, "Podiums"), stat(d.nights_attended, "Nights"),
      stat(d.best_win_streak, "Best streak")) : empty("🎲", "No games played yet."),
    h("div", null, h("div", { class: "section-title" }, h("h2", null, "🏅 Badges"), h("span", { class: "small muted" }, `${d.badges.filter((b) => b.earned).length}/${d.badges.length}`)),
      h("div", { class: "badges" }, d.badges.map((b) => h("div", { class: `badge-card ${b.earned ? "earned" : "locked"}`, title: b.description },
        h("span", { class: "e" }, b.emoji), h("b", null, b.title), h("span", { class: "tiny muted" }, b.description),
        !b.earned && h("div", { class: "bar" }, h("div", { style: { width: `${Math.round((100 * b.progress) / b.goal)}%` } })),
        !b.earned && h("span", { class: "tiny muted" }, `${b.progress}/${b.goal}`))))),
    (d.h2h.nemesis || d.h2h.victim || d.h2h.best_teammate) ? h("div", { class: "grid-2" },
      d.h2h.nemesis && h("div", { class: "card tight center" }, h("div", { class: "tiny muted" }, "😈 Nemesis"), h("b", null, `${d.h2h.nemesis.player.emoji} ${d.h2h.nemesis.player.name}`),
        h("div", { class: "tiny muted" }, `${d.h2h.nemesis.wins}–${d.h2h.nemesis.losses}`)),
      d.h2h.victim && h("div", { class: "card tight center" }, h("div", { class: "tiny muted" }, "🎯 Favourite victim"), h("b", null, `${d.h2h.victim.player.emoji} ${d.h2h.victim.player.name}`),
        h("div", { class: "tiny muted" }, `${d.h2h.victim.wins}–${d.h2h.victim.losses}`)),
      d.h2h.best_teammate && h("div", { class: "card tight center" }, h("div", { class: "tiny muted" }, "🤝 Best teammate"), h("b", null, `${d.h2h.best_teammate.player.emoji} ${d.h2h.best_teammate.player.name}`),
        h("div", { class: "tiny muted" }, `${d.h2h.best_teammate.win_rate}% wins together`))) : null,
    d.h2h.rivals.length ? h("div", null, h("div", { class: "section-title" }, h("h2", null, "⚔️ Head-to-head")),
      h("div", { class: "card tight list" }, d.h2h.rivals.slice(0, 10).map((r) => h("div", { class: "list-item click", onclick: () => go(`/players/${r.player.id}`) },
        h("span", { class: "avatar" }, r.player.emoji), h("span", { class: "grow" }, r.player.name),
        h("span", { class: "small" }, h("b", { style: { color: "#3ccf7f" } }, r.wins), " – ", h("b", { style: { color: "#ef6a50" } }, r.losses), r.ties ? h("span", { class: "muted" }, ` – ${r.ties}`) : null),
        h("span", { class: "tiny muted", style: { width: "3.5rem", textAlign: "right" } }, `${r.games} games`))))) : null,
    d.per_game.length ? h("div", null, h("div", { class: "section-title" }, h("h2", null, "Per game")),
      h("div", { class: "card tight list" }, d.per_game.map((g) => h("div", { class: "list-item click", onclick: () => go(`/boards?game=${g.game.id}`) },
        h("span", { class: "avatar" }, g.game.emoji),
        h("div", { class: "grow" }, h("b", null, g.game.name), h("div", { class: "small muted" }, `${g.sessions} games · ${g.wins} wins · best ${fmtNum(g.best_score, 1)}`)),
        h("b", null, fmtNum(g.avg_points)))))) : null,
    d.recent.length ? h("div", null, h("div", { class: "section-title" }, h("h2", null, "Recent games")),
      h("div", { class: "card tight list" }, d.recent.map((r) => h("div", { class: "list-item click", onclick: () => go(`/results/${r.session_id}`) },
        h("span", { class: "avatar" }, r.game.emoji),
        h("div", { class: "grow" }, h("b", null, r.game.name), h("div", { class: "small muted" }, ago(r.date))),
        h("div", { class: "right" }, h("b", null, medal(r.placement) || `#${r.placement}`), h("div", { class: "tiny muted" }, r.points == null ? "" : `+${fmtNum(r.points)} pts`)))))) : null);
}

