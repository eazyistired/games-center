// Anonymous device id (no login): created once per browser, sent as X-Device-Id.
const KEY = "gc.device";

function randomId() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return "d" + [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function deviceId() {
  try {
    let id = localStorage.getItem(KEY);
    if (!id) { id = randomId(); localStorage.setItem(KEY, id); }
    return id;
  } catch {
    return (window.__gcDevice ||= randomId());
  }
}
