import { api } from "/static/api.js";
import { h, mount, spinner, toast, empty } from "/static/ui.js";
import { homeView } from "./views/home.js";
import { playView } from "./views/play.js";
import { resultsView } from "./views/results.js";
import { boardsView, nightsView, nightView, playersView, playerView } from "./views/stats.js";
import { sessionView, inviteView, watchView, startLive } from "./views/live.js";

const app = document.getElementById("app");

// small cache for data that rarely changes during a session
export const store = {
  _config: null,
  async config() { return (this._config ||= await api("/api/config")); },
  async players() { return api("/api/players"); },
  async games() { return api("/api/games"); },
};

const routes = [
  [/^\/?$/, homeView, "home"],
  [/^\/play\/([\w-]+)$/, playView, "home"],
  [/^\/results\/(\d+)$/, resultsView, "home"],
  [/^\/sessions\/(\d+)$/, sessionView, "nights"],
  [/^\/watch\/(\d+)$/, watchView, "nights"],
  [/^\/invite$/, inviteView, "home"],
  [/^\/boards$/, boardsView, "boards"],
  [/^\/nights$/, nightsView, "nights"],
  [/^\/nights\/(\d+)$/, nightView, "nights"],
  [/^\/players$/, playersView, "players"],
  [/^\/players\/(\d+)$/, playerView, "players"],
];

export function parseHash() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, qs] = raw.split("?");
  return { path, query: new URLSearchParams(qs || "") };
}

export function go(hash) { location.hash = hash; }

// views can register cleanups (e.g. close a websocket) that run when the user navigates away
let cleanups = [];
export function onLeave(fn) { cleanups.push(fn); }
function runCleanups() { cleanups.forEach((fn) => { try { fn(); } catch { /* ignore */ } }); cleanups = []; }

let renderToken = 0;
let currentTab = null;
async function render({ soft = false } = {}) {
  const { path, query } = parseHash();
  const token = ++renderToken;
  runCleanups();
  for (const [re, view, tab] of routes) {
    const m = path.match(re);
    if (!m) continue;
    document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));
    currentTab = tab;
    const scroll = window.scrollY;
    if (!soft) { app.className = "page"; mount(app, spinner()); }
    try {
      const node = await view({ params: m.slice(1), query, app });
      if (token !== renderToken) return; // user navigated away meanwhile
      if (soft) app.className = "page";
      if (node) mount(app, node);
      if (soft) { window.scrollTo(0, scroll); return; }
    } catch (err) {
      console.error(err);
      if (token !== renderToken) return;
      mount(app, empty("😵", err.message || "Something went wrong",
        h("div", { style: { marginTop: "1rem" } }, h("button", { class: "btn", onclick: render }, "Retry"))));
    }
    window.scrollTo(0, 0);
    return;
  }
  go("/");
}

export function rerender() { render(); }

/** Re-render the current screen in place (live updates): keeps the scroll, skips while a dialog is open. */
export function refresh() {
  if (document.querySelector(".modal-back")) return;
  render({ soft: true });
}
export const currentRouteTab = () => currentTab;

window.addEventListener("hashchange", render);
window.addEventListener("unhandledrejection", (e) => toast(e.reason?.message || "Error", "bad"));
store.config().then((c) => { document.title = c.site_name; }).catch(() => {});
render();
startLive();
