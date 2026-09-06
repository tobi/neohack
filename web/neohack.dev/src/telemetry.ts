// Public diagnostics contain categories only: never messages, URLs or save tokens.
const sent = new Set<string>();
export function reportError(error: unknown, buildId = "") {
  const message = error instanceof Error ? error.message : String(error);
  const code = /Another worker or tab owns/.test(message) ? "store_owned"
    : /runtimeUnavailable|pinned engine|original runtime/.test(message) ? "runtime_unavailable"
    : /Unexpected keyword|import declaration|import.*module/i.test(message) ? "module_load"
    : /cloud|fetch|network/i.test(message) ? "network"
    : /storage|transaction|quota/i.test(message) ? "storage"
    : /engineError/i.test(message) ? "engine"
    : "client";
  const key = code + buildId;
  if (sent.has(key) || sent.size >= 10) return;
  sent.add(key);
  void fetch("/api/errors", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, buildId }), keepalive: true,
  }).catch(() => {});
}
window.addEventListener("error", event => reportError(event.error ?? event.message));
window.addEventListener("unhandledrejection", event => reportError(event.reason));
