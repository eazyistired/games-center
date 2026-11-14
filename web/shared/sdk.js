/* Games Center SDK - include in a game with:
 *   <script src="/static/sdk.js"></script>
 * Everything is on window.GC. See docs/ADDING_A_GAME.md.
 */
(function () {
  const params = new URLSearchParams(location.search);
  const sessionId = params.get("session");

  async function call(path, method = "GET", body) {
    const res = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.detail) || res.statusText);
    return data;
  }

  function requireSession() {
    if (!sessionId) {
      location.href = "/";
      throw new Error("No session id - start the game from the Games Center");
    }
  }

  const GC = {
    sessionId,

    /** Session: { id, game, mode: "solo"|"teams", settings, progress, participants[], teams[] } */
    async getSession() {
      requireSession();
      return call(`/api/sessions/${sessionId}`);
    },

    /** Save any JSON-able state; it comes back as session.progress after a reload. */
    async saveProgress(state) {
      requireSession();
      return call(`/api/sessions/${sessionId}/progress`, "PUT", { state });
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
      return call(`/api/sessions/${sessionId}/result`, "POST", result);
    },

    /** Abandon the session (not counted) and go home. */
    async quit() {
      if (sessionId) await call(`/api/sessions/${sessionId}/abandon`, "POST").catch(() => {});
      location.href = "/";
    },

    /** After submitResult: go to the shared results screen. */
    exit() {
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
