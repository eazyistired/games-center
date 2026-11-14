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
    const key = req.decide_url || `takeover:${req.id}`;
    if (live.asked.has(key)) return;
    live.asked.add(key);
    let title = "Take over this game?";
    let text = req.reason === "identity"
      ? `A phone that says it's ${who(req.requester)} wants to take over ${req.game.emoji} ${req.game.name}. Was that you?`
      : `${who(req.requester)}'s phone wants to take over ${req.game.emoji} ${req.game.name}.`;
    let note = "If you allow it, the game continues on that phone from the start of the round.";
    if (req.reason === "name") {
      title = `Use ${who(req.player)} on another phone?`;
      text = `Another phone wants to be ${req.player.name}. Was that you (e.g. a new phone)?`;
      note = "If you allow it, this phone forgets the name (your seat moves to that phone).";
    } else if (req.host) {
      title = "Hand over the host role?";
      text = `${who(req.requester)} wants to become the 👑 host of ${req.game.emoji} ${req.game.name}.`;
      note = "You keep playing; they get the host controls.";
    }
    const back = el("div", { class: "modal-back", style: "z-index:95" });
    const decide = async (approve) => {
      back.remove();
      await call(req.decide_url || `/api/takeover/${req.id}/decide`, "POST", { approve }).catch(() => {});
      if (approve) beat();
    };
    back.append(el("div", { class: "modal" },
      el("h2", {}, title),
      el("p", { class: "muted" }, text),
      el("p", { class: "small muted" }, note),
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

    /** After submitResult: go to the shared results screen (safe to call more than once). */
    exit() {
      if (live.exiting) return;
      live.exiting = true;
      clearInterval(live.timer);
      location.href = sessionId ? `/#/results/${sessionId}` : "/";
    },

    // ------------------------------------------------------------ multi-phone games
    /**
     * Multi-phone: subscribe to this session. onUpdate(session) is called right away and on every
     * change; session.view is what THIS phone may see (from the server engine), session.lobby has
     * the seats. If this phone has no seat yet, it's sent to the lobby to join first.
     * Returns { close() }.
     */
    connect(onUpdate) {
      requireSession();
      let ws = null;
      let closed = false;
      let retry = 0;
      let ping = null;
      const open = () => {
        if (closed) return;
        const proto = location.protocol === "https:" ? "wss" : "ws";
        ws = new WebSocket(`${proto}://${location.host}/ws?session=${sessionId}&device=${DEVICE}`);
        ws.onopen = () => { retry = 0; clearInterval(ping); ping = setInterval(() => { try { ws.send("ping"); } catch { /* ignore */ } }, 15000); };
        ws.onmessage = (e) => {
          const msg = JSON.parse(e.data);
          if (msg.type !== "session") return;
          const s = msg.session;
          if (s.lobby && !s.lobby.my_seat && !s.lobby.is_host && s.status !== "finished") {
            location.href = `/#/sessions/${sessionId}`; // join from the lobby first
            return;
          }
          if (s.status !== "active" && s.status !== "lobby") { closed = true; ws.close(); } // game over: stop listening
          (s.requests || []).forEach(askApproval); // e.g. someone asks to become host
          onUpdate(s);
        };
        ws.onclose = () => { clearInterval(ping); if (!closed) setTimeout(open, Math.min(500 * 2 ** ++retry, 15000)); };
      };
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && ws && ws.readyState > 1) { retry = 0; open(); }
      });
      open();
      return { close() { closed = true; clearInterval(ping); ws?.close(); } };
    },

    /** Multi-phone: hand the 👑 host role to another joined player. */
    async makeHost(playerId) {
      requireSession();
      return call(`/api/sessions/${sessionId}/host`, "POST", { player_id: playerId });
    },

    /** Multi-phone: ask to become host. Resolves "granted" | "denied" | "timeout". */
    async becomeHost() {
      requireSession();
      const r = await call(`/api/sessions/${sessionId}/takeover`, "POST");
      if (r.status === "granted") return "granted";
      for (let i = 0; i < 40; i++) {
        await new Promise((ok) => setTimeout(ok, 2000));
        const st = await call(`/api/sessions/${sessionId}/takeover`).catch(() => ({ status: "pending" }));
        if (st.status === "granted" || st.status === "denied") return st.status;
        if (st.status === "none") return "timeout";
      }
      return "timeout";
    },

    /** Multi-phone: send an action to the server engine. Resolves with the updated session. */
    async act(action) {
      requireSession();
      return call(`/api/sessions/${sessionId}/act`, "POST", action);
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
