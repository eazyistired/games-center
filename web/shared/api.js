// fetch wrapper: JSON in, JSON out, errors -> Error(detail)
import { deviceId } from "./device.js";

export async function api(path, { method = "GET", body, raw = false } = {}) {
  const opts = { method, headers: { "X-Device-Id": deviceId() }, credentials: "same-origin" };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (raw) return res;
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    let msg = (data && data.detail) || res.statusText || "Request failed";
    if (Array.isArray(msg)) msg = msg.map((d) => `${(d.loc || []).slice(-1)[0]}: ${d.msg}`).join(", ");
    const info = typeof msg === "object" ? msg : {};
    if (typeof msg === "object") msg = msg.message || "Request failed";
    const err = new Error(msg);
    err.status = res.status;
    err.info = info;
    throw err;
  }
  return data;
}
