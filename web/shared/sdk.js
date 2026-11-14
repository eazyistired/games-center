/* Games Center SDK - include in a game with:
 *   <script src="/static/sdk.js"></script>
 * Everything is on window.GC. See docs/ADDING_A_GAME.md.
 *
 * Live play: GC.start() makes this phone the one driving the session (asking the current phone
 * for permission when needed), keeps a heartbeat, answers takeover requests from other phones
 * and shows "continued on another phone" when control moves elsewhere.
 */
(function () {
  const params = new URLSearchParams(location.search);
  const sessionId = params.get("session");
  let HEARTBEAT = 5000; // updated from the server's "quiet after" setting

  // ---- device id (same storage key as /static/device.js)
  function deviceId() {
    const rand = () => {
      const a = new Uint8Array(16);
      crypto.getRandomValues(a);
      return "d" + [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
    };
    try {
      let id = localStorage.getItem("gc.device");
      if (!id) { id = rand(); localStorage.setItem("gc.device", id); }
      return id;
    } catch { return (window.__gcDevice ||= rand()); }
  }
  const DEVICE = deviceId();

  async function call(path, method = "GET", body) {
    const headers = { "X-Device-Id": DEVICE };
    if (body) headers["Content-Type"] = "application/json";
    const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = data && data.detail;
      const err = new Error((detail && (detail.message || detail)) || res.statusText);
      err.status = res.status;
      err.info = typeof detail === "object" ? detail : {};
      throw err;
    }
    return data;
  }

  function requireSession() {
    if (!sessionId) {
      location.href = "/";
      throw new Error("No session id - start the game from the Games Center");
    }
  }

  // ---- tiny UI helpers (use the shared styles.css classes)
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "onclick") e.addEventListener("click", v);
      else if (k === "style") e.style.cssText = v;
      else e.setAttribute(k, v);
    }
    for (const k of kids) if (k != null && k !== false) e.append(k);
    return e;
  }
  function overlay(...kids) {
    const box = el("div", { class: "gk-overlay", style: "z-index:90" }, ...kids);
    document.body.append(box);
    return box;
  }
  const who = (p) => (p ? `${p.emoji} ${p.name}` : "someone");
  const btn = (label, cls, onclick) => el("button", { class: `btn xl ${cls || ""}`, onclick }, label);

  // ---- live control state
  const live = { version: null, lost: false, timer: null, asked: new Set(), onLost: null };

  function showLost(message) {
    if (live.lost) return;
    live.lost = true;
    clearInterval(live.timer);
    overlay(
      el("div", { class: "gk-overlay-title", style: "font-size:min(10vw,3rem)" }, "📱➡️📱"),
      el("h2", {}, message || "This game continued on another phone"),
      el("p", { class: "muted" }, "Nothing is lost: the other phone carries on from the start of the round."),
      el("div", { class: "gk-overlay-actions" }, btn("🏠 Home", "primary", () => { location.href = "/"; })));
    live.onLost?.();
  }

  function askApproval(req) {
    if (live.asked.has(req.id)) return;
    live.asked.add(req.id);
    const text = req.reason === "identity"
      ? `A phone that says it's ${who(req.requester)} wants to take over ${req.game.emoji} ${req.game.name}. Was that you?`
      : `${who(req.requester)}'s phone wants to take over ${req.game.emoji} ${req.game.name}.`;
    const back = el("div", { class: "modal-back", style: "z-index:95" });
    const decide = async (approve) => {
      back.remove();
      await call(`/api/takeover/${req.id}/decide`, "POST", { approve }).catch(() => {});
      if (approve) beat();
    };
    back.append(el("div", { class: "modal" },
      el("h2", {}, "Take over this game?"),
      el("p", { class: "muted" }, text),
      el("p", { class: "small muted" }, "If you allow it, the game continues on that phone from the start of the round."),
      el("div", { class: "actions" }, btn("Deny", "ghost", () => decide(false)), btn("Allow", "primary", () => decide(true)))));
    document.body.append(back);
  }

  async function beat() {
    if (live.lost || !sessionId) return;
    try {
      const r = await call(`/api/sessions/${sessionId}/heartbeat`, "POST");
      (r.requests || []).forEach(askApproval);
      if (!r.in_control) {
        if (r.status === "active") showLost(`This game continued on ${who(r.controller && r.controller.player)}'s phone`);
        else if (r.status !== "finished") showLost(`This game was ${r.status}`);
      }
    } catch { /* offline for a moment: try again next beat */ }
  }

  function startHeartbeat() {
    clearInterval(live.timer);
    live.timer = setInterval(beat, HEARTBEAT);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") beat(); });
  }

  /** Ask to take over; resolves with the fresh session once allowed. */
  function takeoverFlow(session) {
    return new Promise((resolve) => {
      let box = null;
      // while on these screens, keep this phone "active" and able to answer requests itself
      const deviceBeat = () => call("/api/devices/heartbeat", "POST", {})
        .then((r) => (r.requests || []).forEach(askApproval)).catch(() => {});
      deviceBeat();
      const beatTimer = setInterval(deviceBeat, HEARTBEAT);
      const close = () => box?.remove();
      const home = () => { location.href = "/"; };
      const ctrl = session.controller;
      const intro = () => {
        close();
        box = overlay(
          el("div", { class: "gk-overlay-title", style: "font-size:min(12vw,3.5rem)" }, `${session.game.emoji}`),
          el("h2", {}, `${session.game.name} is running on ${who(ctrl && ctrl.player)}'s phone`),
          el("p", { class: "muted" }, ctrl && ctrl.active ? "That phone is active right now, so it will be asked to allow this." : "That phone has gone quiet."),
          el("div", { class: "gk-overlay-actions" }, btn("📱 Take over", "primary", request), btn("Back", "", home)));
      };
      const waiting = (r) => {
        close();
        const names = (r.waiting_for || []).map((w) => w.reason === "identity"
          ? `${who(w.player)}'s other phone (you're using the same name)` : `${who(w.player)}'s phone`).join(" and ");
        box = overlay(
          el("div", { class: "spinner" }),
          el("h2", {}, "Waiting for permission…"),
          el("p", { class: "muted" }, `Asked ${names}. If that phone is locked or away, it's allowed automatically within ~${session.quiet_seconds || 30} s.`),
          el("div", { class: "gk-overlay-actions" }, btn("Cancel", "", async () => { await call(`/api/sessions/${sessionId}/takeover`, "DELETE").catch(() => {}); intro(); })));
      };
      const denied = () => {
        close();
        box = overlay(el("h2", {}, "🚫 The other phone said no"),
          el("div", { class: "gk-overlay-actions" }, btn("Ask again", "primary", request), btn("Back", "", home)));
      };
      const granted = async () => { clearInterval(beatTimer); close(); resolve(await call(`/api/sessions/${sessionId}`)); };
      async function poll() {
        const r = await call(`/api/sessions/${sessionId}/takeover`).catch(() => ({ status: "pending" }));
        if (r.status === "granted") return granted();
        if (r.status === "denied") return denied();
        if (r.status === "none") return intro();
        waiting(r);
        setTimeout(poll, 2000);
      }
      async function request() {
        let r;
        try {
          r = await call(`/api/sessions/${sessionId}/takeover`, "POST");
        } catch (e) {
          close();
          box = overlay(el("h2", {}, `😵 ${e.message}`), el("div", { class: "gk-overlay-actions" }, btn("Back", "", home)));
          return;
        }
        if (r.status === "granted") return granted();
        waiting(r);
        setTimeout(poll, 2000);
      }
      intro();
    });
  }

  const GC = {
    sessionId,
    deviceId: DEVICE,
    get lost() { return live.lost; },

    /** Session without taking control (e.g. to show something read-only). */
    async getSession() {
      requireSession();
      return call(`/api/sessions/${sessionId}`);
    },

    /**
     * Load the session AND become the phone driving it. If another phone has it, shows the
     * takeover screens and resolves once allowed. Always use this to boot a one-phone game.
     * opts.onLost: called when another phone takes over later.
     */
    async start(opts = {}) {
      requireSession();
      live.onLost = opts.onLost || null;
      let s = await call(`/api/sessions/${sessionId}`);
      if (s.status !== "active") return s;
      try {
        s = await call(`/api/sessions/${sessionId}/control`, "POST");
      } catch (e) {
        if (e.status === 409 && e.info && e.info.needs_takeover) s = await takeoverFlow(s);
        else throw e;
      }
      live.version = s.version;
      if (s.heartbeat_ms) HEARTBEAT = s.heartbeat_ms;
      startHeartbeat();
      return s;
    },

    /**
     * Save any JSON-able state (returned as session.progress after a reload / takeover).
     * partial = { scores, details } in the submitResult format: the "scores so far", used to
     * auto-finish the session if it is left idle.
     */
    async saveProgress(state, partial) {
      requireSession();
      if (live.lost) return null;
      try {
        const r = await call(`/api/sessions/${sessionId}/progress`, "PUT", { state, version: live.version, partial: partial || null });
        live.version = r.version;
        return r;
      } catch (e) {
        if (e.status === 409) { showLost(); return null; }
        throw e;
      }
    },

    /** Words for deck-based games (respects the chosen decks, avoids words used tonight). */
    async getWords() {
      requireSession();
      return call(`/api/sessions/${sessionId}/words`);
    },

    /**
     * Report the outcome. Only raw scores - the server computes placements & points.
     *   solo:  { scores: [{ player_id, score }], details?, word_plays? }
     *   teams: { scores: [{ team: idx, score }], details?, word_plays? }
     */
    async submitResult(result) {
      requireSession();
      clearInterval(live.timer);
      try {
        return await call(`/api/sessions/${sessionId}/result`, "POST", result);
      } catch (e) {
        if (e.status === 409) showLost();
        throw e;
      }
    },

    /** Abandon the session (not counted) and go home. */
    async quit() {
      clearInterval(live.timer);
      if (sessionId) await call(`/api/sessions/${sessionId}/abandon`, "POST").catch(() => {});
      location.href = "/";
    },

    /** After submitResult: go to the shared results screen. */
    exit() {
      clearInterval(live.timer);
      location.href = sessionId ? `/#/results/${sessionId}` : "/";
    },

    /** Keep the screen on while playing (needs HTTPS). Returns a release() function. */
    async keepAwake() {
      let lock = null;
      const request = async () => {
        try { lock = await navigator.wakeLock?.request("screen"); } catch { /* not supported */ }
      };
      const onVis = () => { if (document.visibilityState === "visible") request(); };
      await request();
      document.addEventListener("visibilitychange", onVis);
      return () => { document.removeEventListener("visibilitychange", onVis); lock?.release?.(); };
    },
  };

  window.GC = GC;
})();
