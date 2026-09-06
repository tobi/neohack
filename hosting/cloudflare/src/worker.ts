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

function ensureJournal(sql: SqlStorage) {
  sql.exec("CREATE TABLE IF NOT EXISTS journal_files (path TEXT PRIMARY KEY, json TEXT NOT NULL)");
  sql.exec("CREATE TABLE IF NOT EXISTS journal_blocks (id TEXT PRIMARY KEY, json TEXT NOT NULL)");
  sql.exec("CREATE TABLE IF NOT EXISTS journal_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
}

export class Vault {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}
  async fetch(request: Request) {
    const sql = this.ctx.storage.sql;
    const url = new URL(request.url);
    const adventures = url.pathname.endsWith("/adventures");
    if (request.method === "GET") {
      try {
        if (adventures) {
          const row = sql.exec("SELECT v FROM journal_meta WHERE k = ?", "adventures").toArray()[0];
          if (!row) return json([], 404);
          return new Response(String(row.v), {
            headers: { "content-type": "application/json", "cache-control": "no-store" },
          });
        }
        const revision = sql.exec("SELECT v FROM journal_meta WHERE k = ?", "revision").toArray()[0]?.v as string | undefined;
        if (!revision) return json({ error: "not found" }, 404);
        return json({
          version: 1,
          revision,
          files: sql.exec("SELECT path, json FROM journal_files ORDER BY path").toArray().map((row) => [row.path, JSON.parse(String(row.json))]),
          blocks: sql.exec("SELECT id, json FROM journal_blocks ORDER BY id").toArray().map((row) => [row.id, JSON.parse(String(row.json))]),
        });
      } catch (error) {
        if (!String(error).includes("no such table")) throw error;
        return json({ error: "not found" }, 404);
      }
    }
    if (request.method !== "PUT") return json({ error: "method not allowed" }, 405);
    ensureJournal(sql);
    const get = (key: string) => sql.exec("SELECT v FROM journal_meta WHERE k = ?", key).toArray()[0]?.v as string | undefined;
    const put = (key: string, value: string) =>
      sql.exec("INSERT INTO journal_meta VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", key, value);
    if (adventures) {
      const body = await request.text();
      if (body.length > 256 * 1024 || !Array.isArray(JSON.parse(body))) return json({ error: "invalid adventures" }, 400);
      put("adventures", body);
      return new Response(null, { status: 204 });
    }
    const body = await request.text();
    if (body.length > 16 * 1024 * 1024) return json({ error: "commit too large" }, 413);
    const data = JSON.parse(body) as {
      version: number;
      base: string | null;
      commit: string;
      files: Array<[string, { blocks: string[] }]>;
      blocks: Array<[string, unknown]>;
    };
    if (
      data.version !== 1 ||
      !UUID.test(data.commit) ||
      (data.base !== null && !UUID.test(data.base)) ||
      !Array.isArray(data.files) ||
      !Array.isArray(data.blocks)
    )
      return json({ error: "invalid commit" }, 400);
    const validHash = (id: unknown): id is string => typeof id === "string" && /^[a-f0-9]{64}$/.test(id);
    if (
      data.files.length > 10000 ||
      data.blocks.length > 10000 ||
      data.files.some(
        (entry) =>
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          typeof entry[0] !== "string" ||
          !entry[0].startsWith("/neonethack/") ||
          !entry[1] ||
          !Array.isArray(entry[1].blocks) ||
          !entry[1].blocks.every(validHash),
      ) ||
      data.blocks.some(
        (entry) => !Array.isArray(entry) || entry.length !== 2 || !validHash(entry[0]) || JSON.stringify(entry[1]).length > 100000,
      )
    )
      return json({ error: "invalid journal data" }, 400);
    if (new Set(data.files.map(([path]) => path)).size !== data.files.length || new Set(data.blocks.map(([id]) => id)).size !== data.blocks.length)
      return json({ error: "duplicate journal entry" }, 400);
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    return this.ctx.storage.transactionSync(() => {
      const revision = get("revision") ?? null;
      if (revision === data.commit) return get("digest") === digest ? json({ revision }) : json({ error: "commit differs" }, 409);
      if (revision !== data.base) return json({ error: "cloud progress changed" }, 409);
      const supplied = new Map(data.blocks);
      const referenced = new Set(data.files.flatMap(([, file]) => file.blocks));
      for (const id of referenced)
        if (!supplied.has(id) && !sql.exec("SELECT id FROM journal_blocks WHERE id = ?", id).toArray().length)
          return json({ error: "missing block" }, 400);
      for (const [id, block] of supplied)
        if (referenced.has(id)) sql.exec("INSERT INTO journal_blocks VALUES (?, ?) ON CONFLICT(id) DO NOTHING", id, JSON.stringify(block));
      sql.exec("DELETE FROM journal_files");
      for (const [path, file] of data.files) sql.exec("INSERT INTO journal_files VALUES (?, ?)", path, JSON.stringify(file));
      for (const row of sql.exec("SELECT id FROM journal_blocks").toArray())
        if (!referenced.has(String(row.id))) sql.exec("DELETE FROM journal_blocks WHERE id = ?", String(row.id));
      put("revision", data.commit);
      put("digest", digest);
      return json({ revision: data.commit });
    });
  }
}

export { Board } from "./board";

async function api(request: Request, env: Env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/api/health") return json({ ok: true, webmcp: "browser-mediated" });
  if (path === "/api/errors") {
    if (request.method !== "POST") return json({error:"method not allowed"},405);
    return env.BOARD.get(env.BOARD.idFromName("board")).fetch(request);
  }
  if (path === "/api/runs") return env.BOARD.get(env.BOARD.idFromName("board")).fetch(request);
  if (path === "/api/stats") {
    return env.BOARD.get(env.BOARD.idFromName("board")).fetch(new Request("https://board/stats"));
  }
  const vault = path.match(/^\/api\/vaults\/([^/]+)(\/adventures)?$/);
  if (vault) {
    const id = decodeURIComponent(vault[1] ?? "");
    if (!UUID.test(id)) return json({ error: "invalid vault" }, 400);
    return env.VAULTS.get(env.VAULTS.idFromName(id)).fetch(request);
  }
  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await api(request, env); }
      catch {
        console.error("request_failed", {code:"server"});
        ctx.waitUntil(env.BOARD.get(env.BOARD.idFromName("board")).fetch(new Request("https://board/errors", {
          method:"POST", body:JSON.stringify({code:"server"})
        })).catch(() => {}));
        return json({error:"server error"},500);
      }
    }
    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    headers.set("content-security-policy", CSP);
    headers.set("x-content-type-options", "nosniff");
    headers.set("referrer-policy", "no-referrer");
    if (url.pathname.startsWith("/runtime/")) headers.set("cache-control", /^\/runtime\/wasm\/[a-f0-9]{64}\//.test(url.pathname) && asset.ok ? "public, max-age=31536000, immutable" : "no-cache");
    return new Response(asset.body, { status: asset.status, headers });
  },
};
