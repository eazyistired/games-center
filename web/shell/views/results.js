import { api } from "/static/api.js";
import { h, toast, medal, fmtNum, fmtDate, modal, promptDialog } from "/static/ui.js";
import { go, rerender } from "../app.js";
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
      if (next.device_mode === "multi" || next.status === "collecting") location.hash = `/sessions/${next.id}`; // new lobby / new words
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

  // friends' words: offer to keep them as a deck (pop-up once per phone, then a card)
  const deck = s.collected_deck;
  async function saveDeck() {
    const name = await promptDialog("Save as a deck", "Deck name", "Friends' words");
    if (!name) return;
    try {
      await api(`/api/sessions/${s.id}/save-deck`, { method: "POST", body: { name } });
      toast(`Saved “${name}”: pick it under Decks next time`, "good");
      rerender();
    } catch (e) { toast(e.message, "bad"); }
  }
  const deckCard = deck && s.status === "finished" ? (deck.saved
    ? h("div", { class: "card small" }, `✍️ These ${deck.count} words are saved as the deck “${deck.name}”.`)
    : h("div", { class: "card row between" },
        h("div", null, h("b", null, `✍️ Keep these ${deck.count} words?`), h("div", { class: "small muted" }, "Save them as a deck to play them again.")),
        h("button", { class: "btn primary small", onclick: saveDeck }, "💾 Save"))) : null;
  const askKey = `gc.deckAsked.${s.id}`;
  let asked = false;
  try { asked = !!localStorage.getItem(askKey); localStorage.setItem(askKey, "1"); } catch { /* ignore */ }
  if (deck && !deck.saved && s.status === "finished" && !asked) {
    setTimeout(async () => {
      const yes = await modal("✍️ Save the friends' words?", h("p", { class: "muted" }, `Keep the ${deck.count} words you wrote as a deck, to play them again in a future game.`), [
        { label: "Not now", class: "ghost", value: false }, { label: "💾 Save as a deck", class: "primary", value: true }]);
      if (yes) saveDeck();
    }, 600);
  }
  return h("div", { class: "stack lg" },
    topbar(`${s.game.emoji} Results`, "/"),
    h("div", { class: "muted small" }, `${s.game.name} · ${s.mode === "teams" ? "Teams" : "Solo"} · game ${data.night_sessions_for_game} of tonight's ${s.game.name}`),
    resultBlock,
    details && h("div", { class: "card small muted" }, details),
    deckCard,
    data.night_standings.length ? h("div", null,
      h("div", { class: "section-title" }, h("h2", null, `Tonight · ${fmtDate(s.night.date)}`), h("a", { class: "small", href: `#/nights/${s.night.id}` }, "Night recap ›")),
      h("div", { class: "card tight" }, boardTable(data.night_standings, { variant: "night" }))) : null,
    h("div", { class: "actionbar" }, h("div", { class: "stack", style: { gap: ".5rem" } },
      h("button", { class: "btn primary xl block", onclick: (e) => again(e.currentTarget) }, "🔁 Play again, same lineup"),
      h("div", { class: "row" },
        h("button", { class: "btn grow", onclick: () => go(`/play/${s.game_id}?from=${s.id}`) }, "✏️ Edit lineup"),
        h("button", { class: "btn grow", onclick: () => go("/") }, "🎲 Other game")))));
}
