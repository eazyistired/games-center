import { api } from "/static/api.js";
import { h, toast, medal, fmtNum, fmtDate } from "/static/ui.js";
import { go } from "../app.js";
import { topbar, boardTable, podium, who } from "./components.js";

export async function resultsView({ params, app }) {
  const sid = params[0];
  const data = await api(`/api/sessions/${sid}/summary`);
  const s = data.session;
  const unitName = s.game.scoring?.unit || "points";
  const unitOf = (n) => (n === 1 && unitName.endsWith("s") ? unitName.slice(0, -1) : unitName);
  const byPid = new Map(s.participants.map((p) => [p.player_id, p]));
  app.classList.add("has-actionbar");

  async function again(btn) {
    btn.disabled = true;
    try {
      if (s.device_mode === "multi") {
        // several phones may tap "Play again": reuse a lobby someone already opened
        const open = (await api("/api/sessions/live")).find((x) => x.game_id === s.game_id && x.status === "lobby" && x.device_mode === "multi");
        if (open) { location.hash = `/sessions/${open.id}`; return; }
      }
      const body = { game_id: s.game_id, mode: s.mode, settings: s.settings, player_ids: s.participants.map((p) => p.player_id), device_mode: s.device_mode };
      if (s.mode === "teams") body.teams = s.teams.map((t) => ({ name: t.name, color: t.color, player_ids: t.player_ids }));
      const next = await api("/api/sessions", { method: "POST", body });
      if (next.device_mode === "multi") location.hash = `/sessions/${next.id}`; // new lobby: everyone re-joins
      else location.href = next.game.url;
    } catch (e) {
      toast(e.message, "bad");
      btn.disabled = false;
    }
  }

  let resultBlock;
  if (s.status === "active") {
    resultBlock = h("div", { class: "card banner stack" }, h("b", null, "This game is still in progress."),
      h("a", { class: "btn", href: s.game.url }, "Resume"));
  } else if (s.status !== "finished") {
    resultBlock = h("div", { class: "card" }, h("span", { class: "badge warn" }, s.status), " This game doesn't count for the leaderboards.");
  } else if (s.mode === "teams") {
    const teams = s.teams.slice().sort((a, b) => a.placement - b.placement);
    resultBlock = h("div", { class: "stack" },
      podium(teams.map((t) => ({ emoji: t.player_ids.map((id) => byPid.get(id)?.emoji).join(""), name: t.name, placement: t.placement, sub: `${fmtNum(t.score, 1)} ${unitOf(t.score)}` }))),
      teams.map((t) => h("div", { class: "card tight team-col", style: { "--team": t.color } },
        h("div", { class: "row between" },
          h("h3", { style: { margin: 0 } }, medal(t.placement), " ", h("span", { class: "team-dot" }), t.name),
          h("div", { class: "right" }, h("b", null, `${fmtNum(t.score, 1)} ${unitOf(t.score)}`), h("div", { class: "tiny muted" }, `+${fmtNum(t.points)} pts each`))),
        h("div", { class: "chips", style: { marginTop: ".5rem" } }, t.player_ids.map((id) => byPid.get(id)).filter(Boolean)
          .map((p) => h("span", { class: "chip sm static" }, h("span", { class: "e" }, p.emoji), p.name))))));
  } else {
    const parts = s.participants.slice().sort((a, b) => (a.placement ?? 99) - (b.placement ?? 99));
    resultBlock = h("div", { class: "stack" },
      podium(parts.map((p) => ({ emoji: p.emoji, name: p.name, placement: p.placement, sub: `${fmtNum(p.score, 1)} ${unitOf(p.score)}` }))),
      h("div", { class: "card tight list" }, parts.map((p) => h("div", { class: "list-item" },
        h("span", { style: { width: "2rem", fontWeight: 800 }, class: p.placement <= 3 ? `medal-${p.placement}` : "muted" }, medal(p.placement) || p.placement),
        h("span", { class: "grow" }, who({ name: p.name, emoji: p.emoji })),
        h("span", { class: "right" }, h("b", null, `${fmtNum(p.score, 1)}`), h("div", { class: "tiny muted" }, p.points == null ? "" : `+${fmtNum(p.points)} pts`))))));
  }

  const details = s.details?.summary;
  return h("div", { class: "stack lg" },
    topbar(`${s.game.emoji} Results`, "/"),
    h("div", { class: "muted small" }, `${s.game.name} · ${s.mode === "teams" ? "Teams" : "Solo"} · game ${data.night_sessions_for_game} of tonight's ${s.game.name}`),
    resultBlock,
    details && h("div", { class: "card small muted" }, details),
    data.night_standings.length ? h("div", null,
      h("div", { class: "section-title" }, h("h2", null, `Tonight · ${fmtDate(s.night.date)}`), h("a", { class: "small", href: `#/nights/${s.night.id}` }, "Night recap ›")),
      h("div", { class: "card tight" }, boardTable(data.night_standings, { variant: "night" }))) : null,
    h("div", { class: "actionbar" }, h("div", { class: "stack", style: { gap: ".5rem" } },
      h("button", { class: "btn primary xl block", onclick: (e) => again(e.currentTarget) }, "🔁 Play again, same lineup"),
      h("div", { class: "row" },
        h("button", { class: "btn grow", onclick: () => go(`/play/${s.game_id}?from=${s.id}`) }, "✏️ Edit lineup"),
        h("button", { class: "btn grow", onclick: () => go("/") }, "🎲 Other game")))));
}
