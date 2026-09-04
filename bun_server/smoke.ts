// WS E2E smoke: new session, handshake, moves, resume from log, live move.
// Usage: bun smoke.ts <port>
const port = process.argv[2] ?? "3001";
const base = `ws://127.0.0.1:${port}/ws`;
const sid = `smoke-${Date.now().toString(36)}`;

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(e);
  });
}
function nextMsg(ws, pred, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    const h = (ev) => {
      const m = JSON.parse(ev.data);
      if (pred(m)) { clearTimeout(t); ws.removeEventListener("message", h); resolve(m); }
    };
    ws.addEventListener("message", h);
  });
}
const write = (ws, line) =>
  ws.send(JSON.stringify({ type: "write", sessionId: sid, line }));

const MOVES = [106, 106, 104, 107, 108, 106];
let moves = 0, snapshots = 0, ended = false;

// Phase 1: new game + moves
let ws = await connect();
ws.send(JSON.stringify({ type: "new", sessionId: sid }));
await nextMsg(ws, (m) => m.type === "session");
write(ws, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "0.1" } }));
// Defensive handshake: wait for the initialize reply before new_game,
// exactly as a real client must.
await nextMsg(ws, (m) => {
  if (m.type !== "engine") return false;
  try { return JSON.parse(m.line).id === 1; } catch { return false; }
});
write(ws, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "new_game", params: { seed: 4242, name: "smoke", role: 1, race: 0, gender: 0, align: 1 } }));
for (;;) {
  const m = await nextMsg(ws, (m) => m.type === "engine" || m.type === "session_ended");
  if (m.type === "session_ended") { ended = true; break; }
  const inner = JSON.parse(m.line);
  if (inner.method === "snapshot") snapshots++;
  if (inner.method === "input") {
    const kind = inner.params.kind;
    if (moves >= MOVES.length) break; // stop answering: hold session open
    let result = {};
    if (kind === "menu") result = { picks: [1], counts: [] }; // decline tutorial if asked
    else if (kind === "yn") result = { answer: "n" };
    else if (kind === "getlin") result = { line: "" };
    else if (kind === "poskey" || kind === "key") result = { x: 0, y: 0, mod: 0, key: MOVES[moves++] };
    else if (kind === "msgmenu") result = { answer: "\r" };
    else if (kind === "extcmd") result = { index: -1 };
    write(ws, JSON.stringify({ jsonrpc: "2.0", id: inner.id, result }));
  }
}
console.log(`phase1: moves=${moves} snapshots=${snapshots}`);
ws.close();

// Phase 2: resume on a fresh socket, expect replay then live input
ws = await connect();
ws.send(JSON.stringify({ type: "resume", sessionId: sid }));
const sess = await nextMsg(ws, (m) => m.type === "session");
console.log(`phase2: resumed=${sess.resumed} replaying=${sess.replaying}`);
let liveSeen = false, replayDone = false;
for (;;) {
  const m = await nextMsg(ws, (m) => m.type === "engine" || m.type === "replay_done" || m.type === "session_ended");
  if (m.type === "replay_done") { replayDone = true; continue; }
  if (m.type === "session_ended") break;
  const inner = JSON.parse(m.line);
  if (inner.method === "input" && replayDone) {
    write(ws, JSON.stringify({ jsonrpc: "2.0", id: inner.id, result: { x: 0, y: 0, mod: 0, key: 106 } }));
    liveSeen = true;
    // one more engine line proves liveness
    await nextMsg(ws, (m) => m.type === "engine");
    break;
  }
}
console.log(`phase2: replayDone=${replayDone} liveMoveAccepted=${liveSeen}`);
if (!replayDone || !liveSeen) { console.error("SMOKE FAIL"); process.exit(1); }
console.log("SMOKE OK");
ws.close();
process.exit(0);
