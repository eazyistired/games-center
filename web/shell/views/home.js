import { api } from "/static/api.js";
import { h, fmtDate, ago, empty, confirmDialog } from "/static/ui.js";
import { store, go, rerender } from "../app.js";
import { who } from "./components.js";

export async function homeView() {
  const [config, games, active, tonight] = await Promise.all([
    store.config(),
    store.games(),
    api("/api/sessions/active"),
    api("/api/leaderboards?period=tonight"),
  ]);

  const resume = active.map((s) => h("div", { class: "card banner row between" },
    h("div", null,
      h("div", { style: { fontWeight: 750 } }, `${s.game.emoji} ${s.game.name} in progress`),
      h("div", { class: "small muted" }, `${s.participants.length} players · started ${ago(s.started_at)}`)),
    h("div", { class: "row" },
      h("button", { class: "btn small ghost", style: { color: "#fff", borderColor: "rgba(255,255,255,.4)" }, onclick: async () => {
        if (await confirmDialog("Discard game?", "It won't count for the leaderboards.", "Discard", true)) {
          await api(`/api/sessions/${s.id}/abandon`, { method: "POST" });
          rerender();
        }
      } }, "✕"),
      h("a", { class: "btn small", href: s.game.url, style: { background: "#fff", color: "#3a22b8", borderColor: "#fff" } }, "Resume"))));

  const top = tonight.entries.slice().sort((a, b) => b.total_points - a.total_points).slice(0, 3);

  return h("div", { class: "stack lg" },
    h("div", null,
      h("div", { class: "row between" },
        h("h1", { style: { margin: 0 } }, config.site_name),
        h("a", { href: "/admin/", class: "btn small ghost", title: "Admin" }, "⚙️")),
      h("div", { class: "muted" }, `Tonight · ${fmtDate(config.tonight)}`)),
    resume.length ? h("div", { class: "stack" }, resume) : null,
    h("div", null,
      h("div", { class: "section-title" }, h("h2", null, "Games")),
      games.length
        ? h("div", { class: "stack grid-auto" }, games.map((g) => h("div", { class: "card click game-tile", onclick: () => go(`/play/${g.id}`) },
            h("div", { class: "big-emoji" }, g.emoji),
            h("div", { class: "grow" },
              h("h3", null, g.name),
              h("div", { class: "small muted" }, g.description),
              h("div", { class: "row wrap", style: { marginTop: ".4rem" } },
                h("span", { class: "badge" }, `${g.min_players}–${g.max_players} players`),
                g.modes.includes("teams") && h("span", { class: "badge info" }, "Teams"),
                g.modes.includes("solo") && h("span", { class: "badge" }, "Solo"))))))
        : empty("🕹️", "No games enabled yet.")),
    top.length ? h("div", null,
      h("div", { class: "section-title" }, h("h2", null, "Tonight so far"), h("a", { href: "#/boards?period=tonight", class: "small" }, "Full table ›")),
      h("div", { class: "card tight list" }, top.map((e, i) => h("div", { class: "list-item click", onclick: () => go(`/players/${e.player.id}`) },
        h("span", { style: { fontSize: "1.3rem", width: "1.8rem" } }, ["🥇", "🥈", "🥉"][i]),
        h("span", { class: "grow" }, who(e.player)),
        h("span", { class: "muted small" }, `${e.wins} W · `, h("b", { style: { color: "var(--text)" } }, Math.round(e.total_points)), " pts"))))) : null,
  );
}
