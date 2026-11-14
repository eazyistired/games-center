// Tiny DOM + UI helpers shared by the shell, admin and games.

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "html") el.innerHTML = v;
      else if (k in el && typeof v !== "string") el[k] = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function mount(target, ...children) {
  target.replaceChildren();
  append(target, children);
}

let toastWrap;
export function toast(message, kind = "") {
  if (!toastWrap) {
    toastWrap = h("div", { class: "toast-wrap" });
    document.body.append(toastWrap);
  }
  const t = h("div", { class: `toast ${kind}` }, message);
  toastWrap.append(t);
  setTimeout(() => t.remove(), kind === "bad" ? 4500 : 2600);
}

export function modal(title, body, actions = []) {
  return new Promise((resolve) => {
    let close = (value) => { back.remove(); resolve(value); };
    const box = h("div", { class: "modal", role: "dialog" },
      title && h("h2", null, title),
      body,
      actions.length && h("div", { class: "actions" },
        actions.map((a) => h("button", {
          class: `btn ${a.class || ""}`,
          onclick: async () => {
            if (a.onclick) {
              const r = await a.onclick();
              if (r === false) return;
              close(r === undefined ? a.value : r);
            } else close(a.value);
          },
        }, a.label))));
    const back = h("div", { class: "modal-back", onclick: (e) => { if (e.target === back) close(undefined); } }, box);
    const onKey = (e) => { if (e.key === "Escape" && back.isConnected && back === [...document.querySelectorAll(".modal-back")].pop()) close(undefined); };
    document.addEventListener("keydown", onKey);
    const _close = close;
    close = (value) => { document.removeEventListener("keydown", onKey); _close(value); };
    document.body.append(back);
    const first = box.querySelector("input, textarea, select");
    if (first) setTimeout(() => first.focus(), 50);
  });
}

export function confirmDialog(title, message, okLabel = "OK", danger = false) {
  return modal(title, h("p", { class: "muted" }, message), [
    { label: "Cancel", class: "ghost", value: false },
    { label: okLabel, class: danger ? "danger" : "primary", value: true },
  ]).then(Boolean);
}

export function promptDialog(title, label, value = "") {
  const input = h("input", { value, onkeydown: (e) => { if (e.key === "Enter") e.target.closest(".modal").querySelector(".btn.primary").click(); } });
  return modal(title, h("label", { class: "field" }, label, input), [
    { label: "Cancel", class: "ghost", value: null },
    { label: "Save", class: "primary", onclick: () => input.value.trim() || false },
  ]);
}

export const medal = (p) => ({ 1: "🥇", 2: "🥈", 3: "🥉" }[p] || "");

export function fmtDate(iso, opts = {}) {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? iso + "T12:00:00" : iso);
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", ...opts });
}

export function fmtTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function ago(iso) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return fmtDate(iso);
}

export const fmtNum = (n, digits = 0) =>
  n === null || n === undefined ? "–" : Number(n).toLocaleString(undefined, { maximumFractionDigits: digits });

export const spinner = () => h("div", { class: "spinner" });

export function empty(emoji, text, extra) {
  return h("div", { class: "empty" }, h("span", { class: "big" }, emoji), h("div", null, text), extra);
}

export function seg(options, value, onchange) {
  const wrap = h("div", { class: "seg" });
  const render = (v) => {
    wrap.replaceChildren(...options.map((o) =>
      h("button", { class: o.value === v ? "on" : "", onclick: () => { render(o.value); onchange(o.value); } }, o.label)));
  };
  render(value);
  return wrap;
}

export function switchField(label, checked, onchange, help) {
  const input = h("input", { type: "checkbox", checked, onchange: (e) => onchange(e.target.checked) });
  return h("label", { class: "switch" }, h("span", null, label, help && h("div", { class: "help muted small" }, help)), input);
}
