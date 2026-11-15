// 📺 The night on the TV: standings, live games, awards, recent results, join QR. Updates live.
import { api } from "/static/api.js";
import { h, mount, fmtDate, fmtNum } from "/static/ui.js";
import { openSocket } from "/static/socket.js";
import { dial, ends } from "/static/dial.js";
import { onLeave } from "../app.js";
import { statusChip } from "./live.js";

export function awardCards(awards, big = false) {
  if (!awards?.length) return null;
  return h("div", { class: `awards ${big ? "big" : ""}` }, awards.map((a) => h("div", { class: "award" },
    h("div", { class: "award-emoji" }, a.emoji),
    h("div", { class: "grow" },
      h("div", { class: "award-title" }, a.title),
      h("div", { class: "award-who" }, a.players.map((p) => `${p.emoji} ${p.name}`).join(" & ")),
      h("div", { class: "tiny muted" }, a.description)),
    h("div", { class: "award-value" }, fmtNum(a.value)))));
}

function liveGame(s) {
  const w = s.watch || {};
  const rows = (w.scoreboard || []).slice().sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).slice(0, 5);
  return h("div", { class: "card tv-live" },
    h("div", { class: "row between" }, h("div", { class: "row" }, h("span", { style: { fontSize: "2rem" } }, s.game.emoji), h("b", { style: { fontSize: "1.3rem" } }, s.game.name)), statusChip(s.live_status)),
    w.headline ? h("div", { class: "tv-headline" }, w.headline) : null,
    w.dial ? h("div", { class: "stack", style: { gap: ".4rem" } }, w.dial.left ? ends([w.dial.left, w.dial.right]) : null,
      dial({ needle: w.dial.needle, target: w.dial.target, reveal: w.dial.target != null }).el) : null,
    rows.length ? h("div", { class: "list" }, rows.map((r) => h("div", { class: "list-item" },
      r.color ? h("span", { class: "team-dot", style: { "--team": r.color } }) : h("span", null, r.emoji),
      h("span", { class: "grow" }, r.name), h("b", null, r.score ?? "–")))) : h("div", { class: "muted small" }, s.status === "lobby" ? "Waiting for players…" : "Scores appear after the first round"));
}

export async function tvView({ query }) {
  document.body.classList.add("tv");
  onLeave(() => document.body.classList.remove("tv"));
  const nightId = query.get("night");
  const root = h("div", { class: "tv-board" });
  async function load() {
    const d = await api(`/api/tv${nightId ? `?night_id=${nightId}` : ""}`);
    const joinUrl = (d.app_url || location.origin).replace(/\/$/, "") + "/";
    const standings = d.standings || [];
    mount(root,
      h("div", { class: "tv-head" },
        h("div", null, h("h1", { class: "logo", style: { margin: 0 } }, d.site_name),
          h("div", { class: "muted" }, d.night ? `${d.night.label || "Game night"} · ${fmtDate(d.night.date)} · ${d.games_played} games played` : `Tonight · ${fmtDate(d.tonight)}`)),
        h("div", { class: "tv-join" }, h("img", { src: `/api/qr.svg?data=${encodeURIComponent(joinUrl)}`, alt: "Join QR" }),
          h("div", null, h("b", null, "Join in"), h("div", { class: "tiny muted" }, joinUrl.replace(/^https?:\/\//, "").replace(/\/$/, ""))))),
      h("div", { class: "tv-grid" },
        h("div", { class: "stack" },
          h("h2", { class: "tv-h" }, "🏆 Tonight"),
          standings.length
            ? h("div", { class: "card tight list tv-standings" }, standings.map((e, i) => h("div", { class: "list-item" },
                h("span", { class: "tv-rank" }, ["🥇", "🥈", "🥉"][i] || i + 1),
                h("span", { class: "tv-e" }, e.player.emoji),
                h("span", { class: "grow tv-name" }, e.player.name),
                h("span", { class: "tv-sub" }, `${e.wins}W · ${e.sessions}G`),
                h("span", { class: "tv-pts" }, fmtNum(e.total_points)))))
            : h("div", { class: "card center muted" }, "No games finished yet tonight."),
          d.recent?.length ? [h("h2", { class: "tv-h" }, "🕑 Latest"),
            h("div", { class: "card tight list" }, d.recent.slice(0, 5).map((r) => h("div", { class: "list-item" },
              h("span", { style: { fontSize: "1.4rem" } }, r.game.emoji), h("span", { class: "grow" }, r.game.name),
              h("span", { class: "small" }, "🏆 ", r.winners.map((w) => `${w.emoji || ""} ${w.name}`.trim()).join(", ") || "–"))))] : null),
        h("div", { class: "stack" },
          d.live?.length ? [h("h2", { class: "tv-h" }, h("span", { class: "live-dot" }), "Playing now"), ...d.live.slice(0, 2).map(liveGame)] : null,
          d.awards?.length ? [h("h2", { class: "tv-h" }, "🏅 Awards so far"), awardCards(d.awards, true)] : null)));
  }
  await load();
  // live nudges (any game changed) -> reload, at most once a second
  let timer = null;
  const sock = openSocket({ onMessage: () => { if (!timer) timer = setTimeout(() => { timer = null; load().catch(() => {}); }, 1000); } });
  const every = setInterval(() => load().catch(() => {}), 30000);
  onLeave(() => { sock.close(); clearInterval(every); clearTimeout(timer); });
  return root;
}

export async function hallView() {
  const d = await api("/api/hall-of-fame");
  const { topbar } = await import("./components.js");
  const monthName = (m) => new Date(`${m}-15`).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  return h("div", { class: "stack" },
    topbar("🏛 Hall of fame", true),
    d.most_titles.length ? h("div", { class: "card tight list" }, h("div", { class: "small muted", style: { padding: ".3rem" } }, "Most monthly titles"),
      d.most_titles.map((x, i) => h("div", { class: "list-item" }, h("span", null, ["👑", "🥈", "🥉"][i] || i + 1),
        h("span", { class: "grow" }, `${x.player.emoji} ${x.player.name}`), h("b", null, `${x.titles}×`)))) : null,
    d.months.length
      ? h("div", { class: "stack" }, d.months.map((m) => h("div", { class: "card row between" },
          h("div", null, h("div", { class: "small muted" }, monthName(m.month)),
            h("div", { style: { fontSize: "1.3rem", fontWeight: 800 } }, `👑 ${m.champion.emoji} ${m.champion.name}`),
            m.runner_up ? h("div", { class: "tiny muted" }, `runner-up ${m.runner_up.emoji} ${m.runner_up.name}`) : null),
          h("div", { class: "right" }, h("b", null, fmtNum(m.avg_points)), h("div", { class: "tiny muted" }, `avg · ${m.sessions} games`)))))
      : h("div", { class: "card center muted" }, "Champions appear once a month has games (with enough games per player)."));
}
