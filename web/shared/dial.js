// The Tuned In dial (SVG): a half circle from 0 (left) to 1 (right) with a needle and an
// optional target (zones 2/3/4). Used by the one-phone game, the multi-phone game and the TV view.
import { h } from "/static/ui.js";

export const ZONE = 0.035; // half-width of the bullseye
const ZONES = [[4, ZONE], [3, ZONE * 3], [2, ZONE * 5]];
export const pointsFor = (d) => (ZONES.find(([, w]) => d <= w) || [0])[0];

const CX = 110, CY = 115, R = 100;
const pt = (v, r = R) => { const a = Math.PI * (1 - v); return [CX + r * Math.cos(a), CY - r * Math.sin(a)]; };
const clamp = (v) => Math.min(1, Math.max(0, v));
const SVGNS = "http://www.w3.org/2000/svg";
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  kids.forEach((k) => el.append(k));
  return el;
}
function wedge(a, b, cls) {
  a = clamp(a); b = clamp(b);
  if (b <= a) return null;
  const [x1, y1] = pt(a), [x2, y2] = pt(b);
  return s("path", { d: `M${CX},${CY} L${x1},${y1} A${R},${R} 0 0 1 ${x2},${y2} Z`, class: cls });
}

/** opts: { target, needle, draggable, onChange, reveal } -> { el, set(value) } */
export function dial({ target = null, needle = 0.5, draggable = false, onChange, reveal = false }) {
  const svg = s("svg", { viewBox: "0 0 220 125", class: `dial ${draggable ? "draggable" : ""}` });
  svg.append(s("path", { d: `M${CX - R},${CY} A${R},${R} 0 0 1 ${CX + R},${CY} Z`, class: "face" }));
  for (let i = 1; i < 10; i++) {
    const [x1, y1] = pt(i / 10, R), [x2, y2] = pt(i / 10, R - 6);
    svg.append(s("line", { x1, y1, x2, y2, class: "tick" }));
  }
  if (target != null) {
    const g = s("g", { class: `target ${reveal ? "reveal" : ""}` });
    const bands = [[2, -5, -3], [3, -3, -1], [4, -1, 1], [3, 1, 3], [2, 3, 5]];
    for (const [p, a, b] of bands) {
      const w = wedge(target + a * ZONE, target + b * ZONE, `z${p}`);
      if (!w) continue;
      g.append(w);
      const mid = clamp(target + ((a + b) / 2) * ZONE);
      if (mid > 0.01 && mid < 0.99) { const [x, y] = pt(mid, R * 0.86); g.append(s("text", { x, y, class: "zlabel" }, String(p))); }
    }
    svg.append(g);
  }
  const line = s("line", { class: "needle" });
  const knob = s("circle", { r: 7, class: "knob" });
  svg.append(line, s("circle", { cx: CX, cy: CY, r: 6, class: "hub" }), knob);
  let value = needle;
  // silent = an update from elsewhere (another phone): move the needle without reporting it back
  const set = (v, silent = false) => {
    value = clamp(v);
    const [x, y] = pt(value, R * 0.92);
    line.setAttribute("x1", CX); line.setAttribute("y1", CY); line.setAttribute("x2", x); line.setAttribute("y2", y);
    knob.setAttribute("cx", x); knob.setAttribute("cy", y);
    if (!silent) onChange?.(value);
  };
  set(value);
  if (draggable) {
    const fromEvent = (e) => {
      const r = svg.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * 220, y = ((e.clientY - r.top) / r.height) * 125;
      let a = Math.atan2(CY - y, x - CX);
      if (a < 0) a = x < CX ? Math.PI : 0; // below the centre: snap to the nearest end
      set(1 - a / Math.PI);
    };
    svg.addEventListener("pointerdown", (e) => { e.preventDefault(); svg.setPointerCapture(e.pointerId); fromEvent(e); });
    svg.addEventListener("pointermove", (e) => { if (svg.hasPointerCapture(e.pointerId)) fromEvent(e); });
  }
  return { el: svg, set, get value() { return value; } };
}

export const ends = (pair) => h("div", { class: "ends" },
  h("div", { class: "end l" }, h("small", null, "◀ left"), pair[0]),
  h("div", { class: "end r" }, h("small", null, "right ▶"), pair[1]));

