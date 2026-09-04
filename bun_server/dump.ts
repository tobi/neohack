// Dump all bridge messages for 12s after new+handshake writes.
const port = process.argv[2] ?? "3001";
const sid = `dump-${Date.now().toString(36)}`;
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
ws.onopen = () => {
  ws.send(JSON.stringify({ type: "new", sessionId: sid }));
  setTimeout(() => {
    ws.send(JSON.stringify({ type: "write", sessionId: sid, line: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "0.1" } }) }));
    ws.send(JSON.stringify({ type: "write", sessionId: sid, line: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "new_game", params: { seed: 99, name: "dump" } }) }));
  }, 500);
};
let n = 0;
ws.onmessage = (ev) => {
  console.log("<<", String(ev.data).slice(0, 160));
  if (++n >= 12) process.exit(0);
};
ws.onerror = (e) => { console.log("WSERR", e?.message); };
setTimeout(() => { console.log(`(got ${n})`); process.exit(0); }, 12000);
