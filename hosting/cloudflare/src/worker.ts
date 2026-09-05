const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; worker-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'";

export interface Env {
  ASSETS: Fetcher;
  VAULTS: DurableObjectNamespace;
  BOARD: DurableObjectNamespace;
}

const json = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-security-policy": CSP,
    },
  });

export class Vault {
  constructor(private readonly ctx: DurableObjectState) {}
  async fetch(request: Request) {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
    );
    const url = new URL(request.url);
    const adventures = url.pathname.endsWith("/adventures");
    const key = adventures ? "adventures" : "snapshot";
    if (request.method === "GET") {
      const row = this.ctx.storage.sql
        .exec("SELECT v FROM kv WHERE k = ?", key)
        .toArray()[0];
      if (!row) return new Response("Not found", { status: 404 });
      return new Response(String(row.v), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }
    if (request.method === "PUT") {
      const body = await request.text();
      JSON.parse(body);
      this.ctx.storage.sql.exec(
        "INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
        key,
        body,
      );
      return new Response(null, { status: 204 });
    }
    return new Response("Method not allowed", { status: 405 });
  }
}

export class Board {
  constructor(private readonly ctx: DurableObjectState) {}
  async fetch(request: Request) {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated INTEGER NOT NULL)",
    );
    if (request.method === "GET") {
      const rows = this.ctx.storage.sql
        .exec("SELECT json FROM runs ORDER BY updated DESC LIMIT 200")
        .toArray();
      return json(rows.map((row) => JSON.parse(String(row.json))));
    }
    if (request.method === "POST") {
      const body = (await request.json()) as {
        runs?: Array<Record<string, unknown>>;
      };
      const runs = Array.isArray(body.runs) ? body.runs : [];
      const now = Date.now();
      for (const run of runs.slice(0, 50)) {
        if (typeof run.id !== "string" || !UUID.test(run.id)) continue;
        const record = {
          id: run.id,
          name: typeof run.name === "string" ? run.name.slice(0, 64) : "Adventurer",
          role: typeof run.role === "string" ? run.role.slice(0, 32) : "valkyrie",
          turn: typeof run.turn === "number" ? run.turn : 0,
          ended: Boolean(run.ended),
          updatedAt: now,
        };
        this.ctx.storage.sql.exec(
          "INSERT INTO runs (id, json, updated) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated = excluded.updated",
          record.id,
          JSON.stringify(record),
          now,
        );
      }
      return new Response(null, { status: 204 });
    }
    return new Response("Method not allowed", { status: 405 });
  }
}

async function api(request: Request, env: Env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/api/health") return json({ ok: true, webmcp: "browser-mediated" });
  if (path === "/api/runs") return env.BOARD.get(env.BOARD.idFromName("board")).fetch(request);
  const vault = path.match(/^\/api\/vaults\/([^/]+)(\/adventures)?$/);
  if (vault) {
    const id = decodeURIComponent(vault[1] ?? "");
    if (!UUID.test(id)) return json({ error: "invalid vault" }, 400);
    return env.VAULTS.get(env.VAULTS.idFromName(id)).fetch(request);
  }
  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return api(request, env);
    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    headers.set("content-security-policy", CSP);
    headers.set("x-content-type-options", "nosniff");
    headers.set("referrer-policy", "no-referrer");
    if (url.pathname.startsWith("/runtime/")) headers.set("cache-control", "public, max-age=60");
    return new Response(asset.body, { status: asset.status, headers });
  },
};
