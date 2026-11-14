import { api } from "/static/api.js";
import { h, mount, spinner, toast, empty } from "/static/ui.js";
import { homeView } from "./views/home.js";
import { playView } from "./views/play.js";
import { resultsView } from "./views/results.js";
import { boardsView, nightsView, nightView, playersView, playerView } from "./views/stats.js";

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

let renderToken = 0;
async function render() {
  const { path, query } = parseHash();
  const token = ++renderToken;
  for (const [re, view, tab] of routes) {
    const m = path.match(re);
    if (!m) continue;
    document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));
    app.className = "page";
    mount(app, spinner());
    try {
      const node = await view({ params: m.slice(1), query, app });
      if (token !== renderToken) return; // user navigated away meanwhile
      if (node) mount(app, node);
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

window.addEventListener("hashchange", render);
window.addEventListener("unhandledrejection", (e) => toast(e.reason?.message || "Error", "bad"));
store.config().then((c) => { document.title = c.site_name; }).catch(() => {});
render();
