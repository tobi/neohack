/* neonethack engine worker: runs the wasm NetHack build off the UI thread.
 *
 * Protocol (postMessage, both directions):
 *   main -> worker  { type: "start", wasmBase }   boot the engine once
 *   main -> worker  { type: "stdin", line }       one UI->engine NDJSON line
 *   main -> worker  { type: "close" }             EOF the engine, then exit
 *   worker -> main  { type: "ready" }             engine booted, awaiting input
 *   worker -> main  { type: "engine", line }      one engine->UI NDJSON line
 *   worker -> main  { type: "log", text }         stray stdout/stderr
 *   worker -> main  { type: "exit", code }        engine returned
 *
 * One game per worker: start() boots, close() terminates. Resume means a
 * fresh worker fed the recorded input log (engine input-request ids are
 * deterministic, so logged answers match the fresh engine's prompts).
 */
let engineStarted = false;
let wasmBase = "";
let stdinQueue = [];
let takeResolver = null;
let closed = false;
// Replay tracking: lines queued before boot are a resume log. The engine
// consumes them without UI help; when the last one is pulled, the session
// is live and the UI's answers count again.
let preloadPending = 0;
let replayDoneSent = false;
let bootCounted = false;

function noteTake() {
  if (preloadPending > 0) {
    preloadPending--;
  }
  if (preloadPending === 0 && !replayDoneSent) {
    replayDoneSent = true;
    postMessage({ type: "replay_done" });
  }
}

function deliver() {
  while (stdinQueue.length && takeResolver) {
    const res = takeResolver;
    takeResolver = null;
    const line = stdinQueue.shift();
    noteTake();
    if (globalThis.__nhTrace) {
      postMessage({ type: "log", text: `trace: take parked→delivered: ${line.slice(0, 70)}` });
    }
    res(line);
  }
}

let takeLogged = false;
globalThis.__nhTakeLine = () => {
  if (!takeLogged) {
    takeLogged = true;
    postMessage({ type: "log", text: "engine awaiting input" });
  }
  // Everything queued before the engine's first pull is resume replay
  // (the log), whenever it arrived during boot.
  if (!bootCounted) {
    bootCounted = true;
    preloadPending = stdinQueue.length;
  }
  return new Promise((resolve) => {
    if (closed) {
      if (globalThis.__nhTrace) postMessage({ type: "log", text: "trace: take resolved null (closed)" });
      resolve(null);
      return;
    }
    if (stdinQueue.length) {
      const line = stdinQueue.shift();
      noteTake();
      if (globalThis.__nhTrace) postMessage({ type: "log", text: `trace: take immediate (${stdinQueue.length} left): ${line.slice(0, 60)}` });
      resolve(line);
      return;
    }
    takeResolver = resolve;
    // Parked with nothing queued: if preload is fully consumed, we're live.
    if (stdinQueue.length === 0) noteTake();
  });
};

globalThis.__nhEmitLine = (line) => {
  postMessage({ type: "engine", line });
};

async function boot() {
  if (engineStarted) return;
  engineStarted = true;
  importScripts(`${wasmBase}nethack.js`);
  const factory = globalThis.createNetHack;
  if (typeof factory !== "function") {
    postMessage({ type: "log", text: "worker: createNetHack missing" });
    postMessage({ type: "exit", code: 127 });
    return;
  }
  postMessage({ type: "ready" });
  const onRealExit = (code) => {
    postMessage({ type: "exit", code });
    close();
  };
  try {
    await factory({
      locateFile: (name) => `${wasmBase}${name}`,
      print: (text) => postMessage({ type: "log", text: String(text) }),
      printErr: (text) =>
        postMessage({ type: "log", text: `stderr: ${String(text)}` }),
      onExit: onRealExit,
    });
    // Resolved without onExit: Asyncify suspended (engine awaiting input),
    // NOT termination. Park the worker; a real exit arrives later via
    // onExit or a thrown ExitStatus. UI-driven close() still terminates us.
    await new Promise(() => {});
  } catch (err) {
    // Thrown ExitStatus carries the real status; anything else is a crash.
    const code = err && err.status !== undefined ? err.status : 1;
    onRealExit(code);
  }
}

onmessage = (ev) => {
  const msg = ev.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "stdin" && globalThis.__nhTrace) {
    postMessage({ type: "log", text: `trace: stdin queued (${stdinQueue.length + 1} pending)` });
  }
  if (msg.type === "start") {
    wasmBase = String(msg.wasmBase || "");
    if (!wasmBase.endsWith("/")) wasmBase += "/";
    globalThis.__nhTrace = !!msg.trace;
    boot();
  } else if (msg.type === "stdin") {
    if (typeof msg.line === "string") {
      stdinQueue.push(msg.line);
      deliver();
    }
  } else if (msg.type === "close") {
    closed = true;
    if (takeResolver) {
      const res = takeResolver;
      takeResolver = null;
      res(null);
    }
  }
};
