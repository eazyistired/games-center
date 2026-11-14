import { h, medal, fmtNum } from "/static/ui.js";
import { go } from "../app.js";

export function topbar(title, back, right) {
  return h("div", { class: "topbar" },
    back && h("button", { class: "back", "aria-label": "Back", onclick: () => (typeof back === "string" ? go(back) : history.back()) }, "‹"),
    h("h1", { class: "grow" }, title),
    right);
}

export function who(player, extra) {
  return h("span", { class: "who" }, h("span", { class: "e" }, player.emoji), h("span", null, player.name), extra);
}

/** Leaderboard table. variant: "overall" (avg points) | "night" (total points) | "game" */
export function boardTable(entries, { variant = "overall", minSessions = 1 } = {}) {
  if (!entries.length) return null;
  const cols = {
    overall: [["Avg", (e) => fmtNum(e.avg_points)], ["W", (e) => e.wins], ["GP", (e) => e.sessions], ["Win%", (e) => e.win_rate == null ? "–" : `${e.win_rate}%`]],
    game: [["Avg", (e) => fmtNum(e.avg_points)], ["W", (e) => e.wins], ["GP", (e) => e.sessions], ["Best", (e) => fmtNum(e.best_score, 1)]],
    night: [["Pts", (e) => fmtNum(e.total_points)], ["W", (e) => e.wins], ["GP", (e) => e.sessions]],
  }[variant];
  const rows = entries.slice();
  if (variant === "night") rows.sort((a, b) => b.total_points - a.total_points || b.wins - a.wins);
  let rank = 0, prev = null;
  return h("div", { class: "table-wrap" }, h("table", { class: "board" },
    h("thead", null, h("tr", null, h("th", null, "#"), h("th", null, "Player"), cols.map(([l]) => h("th", null, l)))),
    h("tbody", null, rows.map((e, i) => {
      let r = e.rank;
      if (variant === "night") { if (e.total_points !== prev) { rank = i + 1; prev = e.total_points; } r = rank; }
      return h("tr", { class: `click ${e.qualified === false && variant !== "night" ? "dim" : ""}`, onclick: () => go(`/players/${e.player.id}`) },
        h("td", { class: `rank ${r && r <= 3 ? "medal-" + r : ""}` }, r ? (medal(r) || r) : "·"),
        h("td", null, who(e.player)),
        cols.map(([, f]) => h("td", null, f(e))));
    }))),
    variant !== "night" && rows.some((e) => !e.qualified) &&
      h("p", { class: "tiny muted", style: { marginTop: ".5rem" } }, `Faded rows need at least ${minSessions} games to be ranked.`));
}

export function podium(items) {
  // items: [{emoji, name, sub, placement?}] in placement order
  if (items.length < 2) return null;
  const [a, b, c] = items;
  const cell = (it, n) => it ? h("div", { class: `p p${n}` },
    h("div", { class: "e" }, it.emoji), h("div", null, medal(it.placement ?? n)),
    h("div", { class: "n" }, it.name), h("div", { class: "small muted" }, it.sub)) : h("div");
  return h("div", { class: "podium" }, cell(b, 2), cell(a, 1), cell(c, 3));
}
