// Read-only public archives. No core/engine import and no disk repair on GET.
import { readdir, readFile, realpath, lstat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Readable } from "node:stream";
import { hostAllowed } from "./origin";
import {
  scanArchive,
  archiveSummary,
  checkedFrame,
  openArchive,
  signature,
  MAX_FRAME_BYTES,
  MAX_ARCHIVE_BYTES,
  MAX_FRAMES,
  type ArchiveSnapshot,
} from "./archive";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });
// Optional single, immutable public source for a dedicated bundle viewer.
// No path or source selection is accepted from HTTP clients.
export interface ReadonlyArchiveSource {
  id: string;
  snapshot(): Promise<ArchiveSnapshot>;
  open(): ReturnType<typeof openArchive>;
  assertUnchanged(): Promise<void>;
}
export function createRunStore(root: string, source?: ReadonlyArchiveSource) {
  root = resolve(root);
  const cache = new Map<string, Promise<ArchiveSnapshot>>();
  let active = 0;
  const waiting: (() => void)[] = [];
  async function limitedScan(path: string, id: string) {
    if (active >= 2) {
      if (waiting.length >= 16) throw Error("Archive scanner busy; retry");
      await new Promise<void>((r) => waiting.push(r));
    } else active++;
    try {
      return await scanArchive(path, id);
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  }
  async function safeFile(id: string, name: string) {
    if (!ID.test(id)) throw Error("Invalid run id");
    const base = await realpath(root),
      dir = join(base, id),
      path = join(dir, name);
    if ((await realpath(dir)) !== dir || (await realpath(path)) !== path)
      throw Error("Archive symlinks are not permitted");
    const info = await lstat(path);
    if (!info.isFile() || info.nlink !== 1)
      throw Error("Archive must be a regular single-link file");
    return path;
  }
  async function snapshot(id: string) {
    if (source) {
      if (id !== source.id) throw Error("Unknown recording");
      return source.snapshot();
    }
    const path = await safeFile(id, "perceptions.jsonl"),
      opened = await openArchive(path);
    const key = `${id}:${signature(opened.s)}`;
    await opened.f.close();
    let promise = cache.get(key);
    if (!promise) {
      promise = limitedScan(path, id);
      cache.set(key, promise);
      promise.catch(() => {
        if (cache.get(key) === promise) cache.delete(key);
      });
      while (cache.size > 8) cache.delete(cache.keys().next().value!);
    }
    return promise;
  }
  async function storedIndex(id: string) {
    const path = await safeFile(id, "perceptions.index.jsonl");
    if ((await lstat(path)).size > 32 * 1024 * 1024)
      throw Error("Index exceeds supported size");
    const text = await readFile(path, "utf8");
    if (text && !text.endsWith("\n")) throw Error("Incomplete stored index");
    const rows: any[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      const row = JSON.parse(line),
        offset = rows.length ? rows.at(-1).offset + rows.at(-1).length : 0;
      if (
        row.sequence !== rows.length ||
        row.offset !== offset ||
        !Number.isSafeInteger(row.length) ||
        row.length < 1 ||
        row.length > MAX_FRAME_BYTES
      )
        throw Error("Invalid stored index");
      rows.push(row);
    }
    return rows;
  }
  async function index(id: string, options: { strict?: boolean } = {}) {
    const snap = await snapshot(id);
    if (options.strict) {
      if (source)
        throw Error("A review source is not a reconstruction publication");
      if (snap.integrity.state !== "complete" || snap.integrity.gaps.length)
        throw Error("Archive is incomplete or contains gaps");
      const rows = await storedIndex(id);
      if (
        rows.length !== snap.rows.length ||
        rows.some(
          (r, i) =>
            ["sequence", "offset", "length", "turn", "revision"].some(
              (k) => r[k] !== snap.rows[i][k],
            ) || !!r.gapBefore !== snap.rows[i].gapBefore,
        )
      )
        throw Error("Archive stored index does not match checkpoint bytes");
    }
    return snap.rows;
  }
  async function list() {
    if (source) return [archiveSummary(await source.snapshot(), source.id)];
    const entries = await readdir(root, { withFileTypes: true }).catch(
        () => [],
      ),
      result: any[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !ID.test(entry.name)) continue;
      let meta: any;
      try {
        // Metadata is just a fast library hint. Always validate the stream when
        // opening a run; stale/missing hints are rebuilt in memory, never on disk.
        const data = await safeFile(entry.name, "perceptions.jsonl"),
          info = await lstat(data);
        try {
          const path = await safeFile(entry.name, "run.json");
          if ((await lstat(path)).size <= 128 * 1024)
            meta = JSON.parse(await readFile(path, "utf8"));
        } catch {}
        if (
          meta?.format === "neonethack.perception" &&
          meta.version === 1 &&
          meta.bytes === info.size &&
          info.size <= MAX_ARCHIVE_BYTES &&
          Number.isSafeInteger(meta.frames) &&
          meta.frames > 0 &&
          meta.frames <= MAX_FRAMES
        ) {
          result.push({ ...meta, sessionId: entry.name, replayReady: true });
        } else
          result.push(archiveSummary(await snapshot(entry.name), entry.name));
      } catch (error) {
        if (meta?.format === "neonethack.perception") {
          result.push({
            sessionId: entry.name,
            title: meta.title ?? "Unavailable recording",
            updatedAt: meta.updatedAt ?? 0,
            frames: 0,
            replayReady: false,
            reason:
              error instanceof Error ? error.message : "Archive unavailable",
          });
          continue;
        }
        try {
          const path = await safeFile(entry.name, "input.log.jsonl"),
            info = await lstat(path);
          result.push({
            sessionId: entry.name,
            title: "Legacy or unavailable recording",
            updatedAt: info.mtimeMs,
            frames: 0,
            replayReady: false,
            reason:
              "No readable public checkpoints. Original data was not modified; legacy inputs require explicit isolated conversion.",
          });
        } catch {}
      }
    }
    return result.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async function handle(req: Request): Promise<Response> {
    if (!hostAllowed(req)) return json({ error: "Host is not permitted" }, 403);
    if (req.method !== "GET" && req.method !== "HEAD")
      return json({ error: "Read-only archive endpoint" }, 405);
    const url = new URL(req.url);
    if (url.pathname === "/runs")
      return json({ version: 1, runs: await list() });
    const match = /^\/runs\/([A-Za-z0-9_-]{1,64})\/(index|frames|export)$/.exec(
      url.pathname,
    );
    if (!match) return json({ error: "Unknown archive route" }, 404);
    try {
      const id = match[1],
        snap = await snapshot(id);
      if (match[2] === "index")
        return json({
          version: 1,
          sessionId: id,
          frames: snap.rows,
          integrity: snap.integrity,
        });
      const from = Number(url.searchParams.get("from") ?? 0),
        limit = Number(url.searchParams.get("limit") ?? 30);
      if (
        match[2] === "frames" &&
        (!Number.isSafeInteger(from) ||
          from < 0 ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 100)
      )
        return json(
          { error: "from must be nonnegative; limit must be 1–100" },
          400,
        );
      if (
        source &&
        match[2] === "export" &&
        url.searchParams.get("raw") === "1"
      )
        return json(
          { error: "Raw evidence is local-only; export the validated prefix" },
          403,
        );
      const { f, s } = source
        ? await source.open()
        : await openArchive(await safeFile(id, "perceptions.jsonl"));
      if (
        s.ino !== snap.stat.ino ||
        s.dev !== snap.stat.dev ||
        s.size < snap.integrity.validBytes ||
        (s.size === snap.stat.size && signature(s) !== snap.signature)
      ) {
        await f.close();
        throw Error("Archive changed; reopen it");
      }
      if (match[2] === "export") {
        const raw = url.searchParams.get("raw") === "1",
          bytes = raw ? s.size : snap.integrity.validBytes;
        const manifest =
          !raw && snap.integrity.state !== "complete"
            ? JSON.stringify({
                format: "neonethack.recordingManifest",
                version: 1,
                integrity: { ...snap.integrity, gaps: undefined },
              }) + "\n"
            : "";
        const headers = {
          "content-type": "application/x-ndjson",
          "content-disposition": `attachment; filename="${id}${raw ? ".raw" : ""}.nh-run.jsonl"`,
          "content-length": String(bytes + Buffer.byteLength(manifest)),
          "cache-control": "no-store",
          "x-recording-integrity": snap.integrity.state,
          "x-recording-valid-bytes": String(snap.integrity.validBytes),
        };
        if (req.method === "HEAD" || !bytes) {
          await f.close();
          return new Response(req.method === "HEAD" ? null : manifest || null, {
            headers,
          });
        }
        const file = f.createReadStream({
          start: 0,
          end: bytes - 1,
          autoClose: true,
        });
        const stream =
          manifest || source
            ? Readable.from(
                (async function* () {
                  try {
                    if (manifest) yield Buffer.from(manifest);
                    for await (const chunk of file) {
                      await source?.assertUnchanged();
                      yield chunk;
                    }
                  } finally {
                    file.destroy();
                  }
                })(),
              )
            : file;
        // Cancellation before the async generator's first pull must also
        // retire its independently opened file descriptor.
        if (stream !== file) stream.once("close", () => file.destroy());
        return new Response(Readable.toWeb(stream) as ReadableStream, {
          headers,
        });
      }
      try {
        const rows = snap.rows.slice(from, from + limit);
        if (!rows.length)
          return json({
            version: 1,
            sessionId: id,
            frames: [],
            integrity: snap.integrity,
          });
        const first = rows[0].offset,
          last = rows.at(-1).offset + rows.at(-1).length;
        if (last - first > 32 * 1024 * 1024)
          return json({ error: "Page too large; request fewer frames" }, 413);
        const buffer = Buffer.alloc(last - first);
        let bytes = 0;
        while (bytes < buffer.length) {
          const read = await f.read(
            buffer,
            bytes,
            buffer.length - bytes,
            first + bytes,
          );
          if (!read.bytesRead) throw Error("Archive changed; reopen it");
          bytes += read.bytesRead;
        }
        await source?.assertUnchanged();
        const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer),
          lines = text.split("\n");
        if (lines.pop() !== "" || lines.length !== rows.length)
          throw Error("Archive changed or page is incomplete");
        const frames = lines.map((line, i) => {
          const frame = checkedFrame(line, id, rows[i].sequence);
          if (
            Buffer.byteLength(line) + 1 !== rows[i].length ||
            frame.response.revision !== rows[i].revision ||
            frame.response.observation.turn !== rows[i].turn
          )
            throw Error("Archive changed; reopen it");
          return frame;
        });
        return json({
          version: 1,
          sessionId: id,
          frames,
          integrity: snap.integrity,
        });
      } finally {
        await f.close();
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Archive unavailable";
      return json(
        { error: message },
        message.includes("changed")
          ? 409
          : message.includes("busy")
            ? 503
            : message.includes("limit") || message.includes("exceeds")
              ? 413
              : 404,
      );
    }
  }
  return { list, index, handle, snapshot };
}
export const runStore = createRunStore(
  process.env.SESSIONS_DIR ?? resolve(import.meta.dir, "../../sessions"),
);
