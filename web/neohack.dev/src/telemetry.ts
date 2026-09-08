// Public diagnostics contain categories only: never messages, URLs or save tokens.
const sent = new Set<string>();
export function reportError(error: unknown, buildId = "", entry?: {kind:"create"|"resume"|"boot";local:boolean}) {
  const message = error instanceof Error ? error.message : String(error);
  const code = /Another worker or tab owns/.test(message) ? "store_owned"
    : /conflicts with remote|newer than this browser/.test(message) ? "cloud_conflict"
    : /runtimeUnavailable|pinned engine|original runtime|no saved runtime identity/.test(message) ? "runtime_unavailable"
    : /Unexpected keyword|import declaration|import.*module/i.test(message) ? "module_load"
    : /cloud|fetch|network/i.test(message) ? "network"
    : /storage|transaction|quota/i.test(message) ? "storage"
    : /engineError/i.test(message) ? "engine"
    : "client";
  const key = code + buildId;
  if (!entry && (sent.has(key) || sent.size >= 10)) return;
  sent.add(key);
  void fetch("/api/errors", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, buildId, ...(entry ? {entry} : {}) }), keepalive: true,
  }).catch(() => {});
}
window.addEventListener("error", event => reportError(event.error ?? event.message));
window.addEventListener("unhandledrejection", event => reportError(event.reason));

const timingCounts=new Map<string,number>();
/** Bounded categorical timings only; no save identity, locations, or game text. */
export function reportTiming(stage:string,duration:number,outcome:'slow'|'complete'|'failed',buildId=''){
 const key=stage+outcome,count=timingCounts.get(key)??0;if(count>=5)return;timingCounts.set(key,count+1);
 void fetch('/api/errors',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:'runtime_timing',buildId,timing:{stage,duration:Math.min(600000,Math.round(duration)),outcome}}),keepalive:true}).catch(()=>{});
}
