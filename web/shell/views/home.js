import { api } from "/static/api.js";
import { h, fmtDate, empty } from "/static/ui.js";
import { store, go } from "../app.js";
import { who } from "./components.js";
import { me, chooseMe, liveCard } from "./live.js";

export async function homeView() {
  const [config, games, live, tonight] = await Promise.all([
    store.config(),
    store.games(),
    api("/api/sessions/live"),
    api("/api/leaderboards?period=tonight"),
  ]);

  const meChip = h("button", { class: "me-chip", onclick: () => chooseMe() },
    me.player ? `${me.player.emoji} ${me.player.name}` : "👋 Who are you?");

  // games you're in first
  const mineFirst = live.slice().sort((a, b) => {
    const m = (s) => (me.player && s.participants.some((p) => p.player_id === me.player.id) ? 0 : 1);
    return m(a) - m(b);
  });
  const top = tonight.entries.slice().sort((a, b) => b.total_points - a.total_points).slice(0, 3);

  return h("div", { class: "stack lg" },
    h("div", null,
      h("div", { class: "row between" },
        h("h1", { class: "logo" }, config.site_name),
        h("div", { class: "row" },
          h("a", { href: "#/invite", class: "btn small ghost", title: "Invite (QR code)" }, "📲"),
          h("a", { href: "/admin/", class: "btn small ghost", title: "Admin" }, "⚙️"))),
      h("div", { class: "row between", style: { marginTop: ".35rem" } },
        h("div", { class: "muted" }, `Tonight · ${fmtDate(config.tonight)}`),
        meChip)),
    live.length ? h("div", null,
      h("div", { class: "section-title" }, h("h2", null, h("span", { class: "live-dot" }), "Live now")),
      h("div", { class: "stack" }, mineFirst.map(liveCard))) : null,
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
