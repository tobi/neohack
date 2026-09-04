// neonethack-mcp over the web: the same world, reachable over HTTP via
// MCP's Streamable HTTP transport. Any MCP client that speaks HTTP can
// step in — no stdio needed. Shares all game state with server.ts
// (imported, not spawned: one process, one world-set).
//
//   bun src/http.ts            # listens on 127.0.0.1:3100 (MCP_PORT)
//   POST /mcp                  # JSON-RPC request(s); initialize mints
//                              # an Mcp-Session-Id the client echoes back
//   GET  /mcp                  # SSE stream (server has nothing to push;
//                              # every perception answers a deed)
//   DELETE /mcp                # close the web session (worlds persist)
//   GET  /                     # manifest: tools + a curl walkthrough
//
// Expose it e.g. with: tailscale serve --bg 3100
// Then any client on the tailnet enters at the served address + /mcp.
import { dispatch, TOOLS } from "./server";

const PORT = Number(process.env.MCP_PORT ?? 3100);
const sessions = new Set<string>();

const cors = {
  "access-control-allow-headers": "content-type, mcp-session-id, mcp-protocol-version",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-expose-headers": "mcp-session-id",
};

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors, ...extra },
  });

export async function handlePost(req: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
  }
  const sid = req.headers.get("mcp-session-id");
  const batch = Array.isArray(raw) ? raw : [raw];
  // initialize without a session mints one; everything else needs it.
  const isInit = batch.some(
    (m) => m && typeof m === "object" && (m as { method?: string }).method === "initialize",
  );
  if (!isInit && (!sid || !sessions.has(sid))) {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "unknown web session: initialize first" } }, 404);
  }
  const out: Record<string, unknown>[] = [];
  for (const m of batch) {
    const r = await dispatch(m);
    if (r) out.push(r);
  }
  const headers: Record<string, string> = {};
  if (isInit) {
    const id = crypto.randomUUID();
    sessions.add(id);
    headers["mcp-session-id"] = id;
  }
  if (out.length === 0) return new Response(null, { status: 202, headers: { ...cors, ...headers } });
  return json(Array.isArray(raw) ? out : out[0], 200, headers);
}

export function handleGet(req: Request): Response {
  const sid = req.headers.get("mcp-session-id");
  if (!sid || !sessions.has(sid)) {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "unknown web session: initialize first" } }, 404);
  }
  // The world never speaks first: every perception answers a deed, so
  // this stream idles until the client leaves. Still here for spec shape.
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(": the way stays open\n\n"));
    },
    cancel() {},
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", ...cors },
  });
}

const MANIFEST = {
  name: "neonethack-mcp",
  transport: "streamable-http",
  endpoint: "/mcp",
  tools: TOOLS.map((t) => t.name),
  try: [
    'SID=$(curl -s -D- -o /tmp/init.json -X POST $BASE/mcp -H "content-type: application/json" -H "accept: application/json, text/event-stream" -d \'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}\' | grep -i mcp-session-id | tr -d "\\r" | cut -d" " -f2)',
    'curl -s -X POST $BASE/mcp -H "content-type: application/json" -H "accept: application/json, text/event-stream" -H "mcp-session-id: $SID" -d \'{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"new_game","arguments":{"seed":7,"name":"webwalker","role":"healer","race":"elf","gender":"female","align":"neutral"}}}\'',
  ],
};

export async function handleDelete(req: Request): Promise<Response> {
  const sid = req.headers.get("mcp-session-id");
  if (!sid || !sessions.has(sid)) return json({ error: "unknown web session" }, 404);
  sessions.delete(sid);
  return json({});
}

// Mountable by other servers (bun_server mounts these same-origin at
// /mcp so the play page and agents share one world-set, one process).
export async function handleMcp(req: Request): Promise<Response> {
  const origin = req.headers.get("origin");
  const allowed = (process.env.MCP_ALLOWED_ORIGINS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (origin && origin !== new URL(req.url).origin && !allowed.includes(origin))
    return json({ error: "Origin is not permitted" }, 403);
  let response: Response;
  if (req.method === "OPTIONS") response = new Response(null, { status: 204, headers: cors });
  else if (req.method === "POST") response = await handlePost(req);
  else if (req.method === "GET") response = handleGet(req);
  else if (req.method === "DELETE") response = await handleDelete(req);
  else response = json({ error: "method not allowed" }, 405);
  if (origin) {
    response.headers.set("access-control-allow-origin", origin);
    response.headers.set("vary", "Origin");
  }
  return response;
}

if (import.meta.main) {
  Bun.serve({
    port: PORT,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      if (url.pathname === "/" && req.method === "GET") return json(MANIFEST);
      if (url.pathname !== "/mcp") return json({ error: "not found" }, 404);
      return handleMcp(req);
    },
  });

  console.log(`webmcp listening on 127.0.0.1:${PORT} (/mcp)`);
}
