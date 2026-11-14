// Live updates over WebSocket with auto-reconnect.
//   const sock = openSocket({ session: 12, onMessage(msg) {...} });  sock.close();
// Without `session` it subscribes to the "live" list (a nudge whenever any session changes).
import { deviceId } from "./device.js";

export function openSocket({ session = null, onMessage, onStatus } = {}) {
  let ws = null;
  let closed = false;
  let retry = 0;
  let pingTimer = null;
  let retryTimer = null;

  const url = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const q = new URLSearchParams({ device: deviceId() });
    if (session) q.set("session", session);
    return `${proto}://${location.host}/ws?${q}`;
  };

  function connect() {
    if (closed) return;
    clearTimeout(retryTimer);
    try { ws = new WebSocket(url()); } catch { return schedule(); }
    ws.onopen = () => {
      retry = 0;
      onStatus?.("online");
      clearInterval(pingTimer);
      pingTimer = setInterval(() => { try { ws.send("ping"); } catch { /* reconnect handles it */ } }, 15000);
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type !== "pong") onMessage?.(msg);
    };
    ws.onclose = () => { clearInterval(pingTimer); onStatus?.("offline"); schedule(); };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  }
  function schedule() {
    if (closed) return;
    retry = Math.min(retry + 1, 6);
    retryTimer = setTimeout(connect, 500 * 2 ** retry); // 1s, 2s, 4s ... 32s
  }
  const onVisible = () => {
    if (document.visibilityState === "visible" && (!ws || ws.readyState > 1)) { retry = 0; connect(); }
  };
  document.addEventListener("visibilitychange", onVisible);
  connect();
  return {
    send(text) { try { ws?.send(text); } catch { /* ignore */ } },
    close() {
      closed = true;
      clearInterval(pingTimer);
      clearTimeout(retryTimer);
      document.removeEventListener("visibilitychange", onVisible);
      try { ws?.close(); } catch { /* ignore */ }
    },
  };
}
