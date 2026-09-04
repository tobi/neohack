// Read-only public-perception archives. No engine/core import: replay cannot act.
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { hostAllowed } from "./origin";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

export function createRunStore(root: string) {
  root = resolve(root);
  async function safeFile(id: string, name: string) {
    if (!ID.test(id)) throw new Error("Invalid run id");
    const base = await realpath(root),
      dir = await realpath(join(base, id));
    if (dir !== join(base, id))
      throw new Error("Run directory is not a direct child");
    const path = await realpath(join(dir, name));
    if (!path.startsWith(dir + sep)) throw new Error("Invalid archive path");
    return path;
  }
  async function list() {
    const entries = await readdir(root, { withFileTypes: true }).catch(
      () => [],
    );
    const result = [];
    for (const e of entries) {
      if (!e.isDirectory() || !ID.test(e.name)) continue;
      try {
        const path = await safeFile(e.name, "run.json");
        if ((await stat(path)).size > 128 * 1024) continue;
        const meta = JSON.parse(await readFile(path, "utf8"));
        if (meta.format !== "neonethack.perception" || meta.version !== 1)
          continue;
        result.push({ ...meta, sessionId: e.name, replayReady: true });
      } catch {
        // Legacy runs are listed honestly, never passed off as event recordings.
        try {
          const path = await safeFile(e.name, "input.log.jsonl");
          const info = await stat(path);
          result.push({
            sessionId: e.name,
            title: "Legacy input-log run",
            updatedAt: info.mtimeMs,
            frames: 0,
            replayReady: false,
            reason:
              "No public perception recording. Requires an explicit isolated conversion.",
          });
        } catch {}
      }
    }
    return result.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async function index(id: string) {
    const path = await safeFile(id, "perceptions.index.jsonl");
    if ((await stat(path)).size > 32 * 1024 * 1024)
      throw new Error("Index exceeds supported size");
    const lines = (await readFile(path, "utf8")).split("\n");
    const rows: any[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (
        r.sequence !== rows.length ||
        !Number.isSafeInteger(r.offset) ||
        r.offset < 0 ||
        !Number.isSafeInteger(r.length) ||
        r.length < 1
      )
        throw new Error("Invalid archive index");
      if (rows.length && r.offset !== rows.at(-1).offset + rows.at(-1).length)
        throw new Error("Archive index contains a gap");
      rows.push(r);
    }
    return rows;
  }
  async function handle(req: Request): Promise<Response> {
    if (!hostAllowed(req)) return json({ error: "Host is not permitted" }, 403);
    if (req.method !== "GET" && req.method !== "HEAD")
      return json({ error: "Read-only archive endpoint" }, 405);
    const url = new URL(req.url);
    if (url.pathname === "/runs")
      return json({ version: 1, runs: await list() });
    const m = /^\/runs\/([A-Za-z0-9_-]{1,64})\/(index|frames|export)$/.exec(
      url.pathname,
    );
    if (!m) return json({ error: "Unknown archive route" }, 404);
    try {
      const id = m[1];
      if (m[2] === "index")
        return json({ version: 1, sessionId: id, frames: await index(id) });
      const file = Bun.file(await safeFile(id, "perceptions.jsonl"));
      if (m[2] === "export")
        return new Response(req.method === "HEAD" ? null : file, {
          headers: {
            "content-type": "application/x-ndjson",
            "content-disposition": `attachment; filename="${id}.nh-run.jsonl"`,
            "cache-control": "no-store",
          },
        });
      const from = Number(url.searchParams.get("from") ?? 0),
        limit = Number(url.searchParams.get("limit") ?? 30);
      if (
        !Number.isSafeInteger(from) ||
        from < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        return json(
          { error: "from must be nonnegative; limit must be 1–100" },
          400,
        );
      const rows = (await index(id)).slice(from, from + limit);
      if (!rows.length) return json({ version: 1, sessionId: id, frames: [] });
      const first = rows[0].offset,
        last = rows.at(-1).offset + rows.at(-1).length;
      if (last - first > 32 * 1024 * 1024)
        return json({ error: "Page too large; request fewer frames" }, 413);
      const text = await file.slice(first, last).text();
      const frames = text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      return json({ version: 1, sessionId: id, frames });
    } catch (e) {
      return json(
        { error: e instanceof Error ? e.message : "Archive unavailable" },
        404,
      );
    }
  }
  return { list, index, handle };
}
export const runStore = createRunStore(
  process.env.SESSIONS_DIR ?? resolve(import.meta.dir, "../../sessions"),
);
