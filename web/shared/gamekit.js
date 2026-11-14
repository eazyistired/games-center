// Shared building blocks for games: sound, text fitting, countdowns, pause overlay.
import { h, mount } from "/static/ui.js";

export function shuffle(a) {
  const arr = a.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Web Audio beeps. enabled() is checked on every call (so a settings toggle works live). */
export function createSound(enabled = () => true) {
  let ctx = null;
  const beep = (freq, dur = 0.12, type = "sine", gain = 0.18, when = 0) => {
    if (!enabled() || !ctx) return;
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  };
  const vibrate = (p) => { try { if (enabled()) navigator.vibrate?.(p); } catch { /* ignore */ } };
  return {
    /** Call from a tap handler (browsers only allow audio after a user gesture). */
    unlock() {
      try {
        ctx ||= new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === "suspended") ctx.resume();
      } catch { /* no audio */ }
    },
    beep,
    correct() { beep(660, 0.1, "triangle"); beep(990, 0.18, "triangle", 0.18, 0.09); vibrate(60); },
    skip() { beep(320, 0.12, "square", 0.1); beep(220, 0.2, "square", 0.1, 0.1); vibrate([30, 40, 30]); },
    tick() { beep(1200, 0.04, "sine", 0.12); },
    count() { beep(520, 0.12, "sine", 0.2); },
    go() { beep(880, 0.25, "sine", 0.22); },
    end() { beep(180, 0.6, "sawtooth", 0.15); vibrate(400); },
    win() { beep(660, 0.12, "triangle"); beep(880, 0.12, "triangle", 0.18, 0.1); beep(1320, 0.3, "triangle", 0.18, 0.2); },
  };
}

/** Shrink an element's font until it fits (call after it is in the DOM). */
export function fit(el, maxH = 0.55, maxW = 0.92, min = 22) {
  el.style.fontSize = "";
  let size = parseFloat(getComputedStyle(el).fontSize);
  while ((el.scrollHeight > innerHeight * maxH || el.scrollWidth > innerWidth * maxW) && size > min) {
    size -= 4;
    el.style.fontSize = `${size}px`;
  }
}

/** Big 3-2-1 inside `container`; resolves when done. */
export function countdown(container, label, sound, from = 3) {
  return new Promise((resolve) => {
    let n = from;
    const num = h("div", { class: "gk-countdown" }, n);
    mount(container, h("div", { class: "gk-center" }, h("div", { class: "muted", style: { fontSize: "1.2rem" } }, label), num));
    sound?.count();
    const iv = setInterval(() => {
      n--;
      if (n <= 0) { clearInterval(iv); sound?.go(); resolve(); return; }
      num.textContent = n;
      num.style.animation = "none"; void num.offsetWidth; num.style.animation = "";
      sound?.count();
    }, 900);
  });
}

/**
 * A countdown timer driven by requestAnimationFrame, with pause/resume.
 * onTick(msLeft) every frame, onEnd() when it reaches 0.
 */
export function createTimer(ms, { onTick, onEnd }) {
  let endAt = Date.now() + ms;
  let remaining = ms;
  let running = true;
  let done = false;
  const frame = () => {
    if (!running || done) return;
    const left = Math.max(0, endAt - Date.now());
    onTick?.(left);
    if (left <= 0) { done = true; onEnd?.(); return; }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  return {
    pause() { if (!running || done) return; running = false; remaining = Math.max(0, endAt - Date.now()); },
    resume() { if (running || done) return; running = true; endAt = Date.now() + remaining; requestAnimationFrame(frame); },
    stop() { done = true; running = false; },
    left() { return running ? Math.max(0, endAt - Date.now()) : remaining; },
    get paused() { return !running && !done; },
  };
}

/**
 * Full-screen pause overlay (hides what's underneath) with Resume (3-2-1 first) and extra actions.
 * actions: [{ label, class, onclick }]. Returns { close }.
 */
export function pauseOverlay(parent, { title = "Paused", subtitle = "", sound, onResume, actions = [], resumeLabel = "Get ready!" }) {
  const box = h("div", { class: "gk-overlay", onclick: (e) => e.stopPropagation() });
  const close = () => box.remove();
  mount(box,
    h("div", { class: "gk-overlay-title" }, title),
    subtitle && h("div", { class: "muted" }, subtitle),
    h("div", { class: "gk-overlay-actions" },
      h("button", { class: "btn primary xl", onclick: async () => {
        if (box.dataset.busy) return;
        box.dataset.busy = "1";
        await countdown(box, resumeLabel, sound);
        close();
        onResume?.();
      } }, "▶ Resume"),
      actions.map((a) => h("button", { class: `btn xl ${a.class || ""}`, onclick: () => { if (!box.dataset.busy) { close(); a.onclick(); } } }, a.label))));
  parent.append(box);
  return { close };
}

/** Pause automatically when the page is hidden (phone locked / app switched). Returns an unsubscribe. */
export function onHidden(fn) {
  const handler = () => { if (document.visibilityState === "hidden") fn(); };
  document.addEventListener("visibilitychange", handler);
  return () => document.removeEventListener("visibilitychange", handler);
}

/** Keep the screen on + go fullscreen if possible. */
export async function goImmersive() {
  try {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    }
  } catch { /* iOS */ }
  return window.GC?.keepAwake?.();
}
