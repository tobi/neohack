// Explicit maintenance helper. Save only worlds already loaded by this server;
// never resume an archived world or touch another bridge's run files.
// bun tools/drain-server.ts http://127.0.0.1:3000 [--apply]
const base =
  process.argv.find((a) => /^https?:\/\//.test(a)) ?? "http://127.0.0.1:3000";
const apply = process.argv.includes("--apply");
let transport = "",
  seq = 0;
async function rpc(method: string, params: unknown = {}) {
  const r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(transport ? { "mcp-session-id": transport } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }),
    signal: AbortSignal.timeout(45000),
  });
  if (!r.ok) throw Error(`HTTP ${r.status}`);
  transport = r.headers.get("mcp-session-id") ?? transport;
  const d = await r.json();
  if (d.error) throw Error(d.error.message);
  return d;
}
async function tool(name: string, args: unknown) {
  const d = await rpc("tools/call", { name, arguments: args });
  return JSON.parse(d.result.content[0].text);
}
await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "maintenance-drain", version: "1" },
});
const list = await fetch(`${base}/runs`);
if (!list.ok) throw Error("Cannot enumerate recorded runs");
const runs = (await list.json()).runs ?? [];
const result = [];
for (const run of runs) {
  const live = await tool("get_state", { sessionId: run.sessionId });
  if (live.error || !live.observation) continue;
  const row: any = {
    sessionId: run.sessionId,
    turn: live.observation.turn,
    decision: live.decision?.kind ?? null,
  };
  if (apply) {
    const done = await tool("end_session", { sessionId: run.sessionId });
    if (done.error) throw Error(JSON.stringify(done.error));
    row.saved = true;
    row.finalTurn = done.observation.turn;
  }
  result.push(row);
}
console.log(
  JSON.stringify(
    { base, apply, loaded: result.length, worlds: result },
    null,
    2,
  ),
);
