// Public-only, engine-free review of one completed salvage bundle. Never
// follows manifest sourcePath/entry paths or opens private evidence/pins.
import { open, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { scanArchive, MAX_ARCHIVE_BYTES, MAX_FRAMES } from "./archive";
import { createRunStore } from "./runs";
import { parseWireJson } from "./wire-json";
const FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const MAX_MANIFEST = 32 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,64}$/,
  HASH = /^[a-f0-9]{64}$/;
const sig = (s: any) =>
  [s.dev, s.ino, s.size, s.nlink, s.mtimeNs, s.ctimeNs].join(":");
const at = (dir: FileHandle, name: string) => `/proc/self/fd/${dir.fd}/${name}`;
const integer = (n: any, max: number) =>
  Number.isSafeInteger(n) && n >= 0 && n <= max;
async function regular(path: string, limit: number) {
  const f = await open(path, FLAGS);
  try {
    const s = await f.stat({ bigint: true });
    if (!s.isFile() || s.nlink !== 1n || s.size > BigInt(limit))
      throw Error(
        "Bundle file must be regular, single-link and within its size limit",
      );
    return { f, s };
  } catch (e) {
    await f.close();
    throw e;
  }
}
async function exact(f: FileHandle, size: number) {
  const bytes = Buffer.alloc(size);
  let pos = 0;
  while (pos < size) {
    const r = await f.read(bytes, pos, size - pos, pos);
    if (!r.bytesRead) throw Error("Bundle changed while reading");
    pos += r.bytesRead;
  }
  return bytes;
}
function validateManifest(m: any) {
  if (
    m?.format !== "neonethack.salvageBundle" ||
    m.version !== 1 ||
    m.state !== "complete" ||
    m.readOnly !== true ||
    m.engineExecuted !== false ||
    m.liveRecovery !== false ||
    typeof m.sourceSessionId !== "string" ||
    !ID.test(m.sourceSessionId) ||
    !integer(m.createdAt, Number.MAX_SAFE_INTEGER) ||
    !integer(m.bytes, 10 * 1024 ** 3) ||
    !Array.isArray(m.entries) ||
    m.entries.length > 20000
  )
    throw Error("Invalid or incomplete salvage manifest");
  const info = m.integrity;
  if (
    !info ||
    !["partial", "corrupt", "limited"].includes(info.state) ||
    !integer(info.totalBytes, MAX_ARCHIVE_BYTES) ||
    !integer(info.validBytes, info.totalBytes) ||
    !integer(info.completeFrames, MAX_FRAMES) ||
    !Array.isArray(info.gaps) ||
    info.gaps.length > MAX_FRAMES ||
    info.gaps.some(
      (n: any, i: number) =>
        !integer(n, Math.max(0, info.completeFrames - 1)) ||
        (i && n <= info.gaps[i - 1]),
    )
  )
    throw Error("Invalid salvage integrity notice");
  const names = new Set<string>();
  let total = 0,
    checkpoint: any;
  for (const e of m.entries) {
    if (
      typeof e?.path !== "string" ||
      !e.path ||
      Buffer.byteLength(e.path) > 4096 ||
      e.path.includes("\\") ||
      e.path.includes("\0") ||
      e.path.split("/").length > 33 ||
      e.path.split("/").some((p: string) => !p || p === "." || p === "..") ||
      names.has(e.path) ||
      !["file", "directory"].includes(e.kind) ||
      !integer(e.bytes, MAX_ARCHIVE_BYTES) ||
      !integer(e.mode, 0o7777) ||
      typeof e.signature !== "string" ||
      (e.kind === "file" &&
        (typeof e.sha256 !== "string" || !HASH.test(e.sha256))) ||
      (e.kind === "directory" && e.bytes !== 0)
    )
      throw Error("Invalid salvage entry catalog");
    names.add(e.path);
    total += e.bytes;
    if (e.path === "perceptions.jsonl") checkpoint = e;
  }
  if (
    total !== m.bytes ||
    !checkpoint ||
    checkpoint.kind !== "file" ||
    checkpoint.bytes !== info.totalBytes
  )
    throw Error("Manifest checkpoint entry is inconsistent");
  if (info.completeFrames === 0) {
    if (m.review !== null)
      throw Error("Empty salvage cannot claim a playable export");
  } else if (
    m.review?.file !== "review.nh-run.jsonl" ||
    typeof m.review.sha256 !== "string" ||
    !HASH.test(m.review.sha256) ||
    !integer(m.review.bytes, MAX_ARCHIVE_BYTES + MAX_MANIFEST) ||
    m.review.bytes <= info.validBytes
  )
    throw Error("Invalid review export descriptor");
  return checkpoint;
}
export async function openBundleReview(path: string) {
  if (process.platform !== "linux")
    throw Error(
      "Pinned-descriptor bundle review currently requires Linux /proc",
    );
  const canonical = await realpath(resolve(path));
  const root = await open(canonical, FLAGS | constants.O_DIRECTORY);
  const handles: FileHandle[] = [root];
  let closed = false;
  try {
    const rootStat = await root.stat({ bigint: true });
    try {
      await lstat(at(root, "FAILED.json"));
      throw Error("Bundle has a failure marker");
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    const manifest = await regular(at(root, "manifest.json"), MAX_MANIFEST);
    handles.push(manifest.f);
    const m: any = parseWireJson(
      new TextDecoder("utf8", { fatal: true }).decode(
        await exact(manifest.f, Number(manifest.s.size)),
      ),
      MAX_MANIFEST,
    );
    const entry = validateManifest(m);
    const evidence = await open(
      at(root, "evidence"),
      FLAGS | constants.O_DIRECTORY,
    );
    handles.push(evidence);
    const evidenceStat = await evidence.stat({ bigint: true });
    const data = await regular(
      at(evidence, "perceptions.jsonl"),
      MAX_ARCHIVE_BYTES,
    );
    handles.push(data.f);
    if (data.s.size !== BigInt(entry.bytes))
      throw Error("Public checkpoint size does not match manifest");
    async function assertUnchanged() {
      if (closed) throw Error("Bundle review is closed");
      for (const [f, s] of [
        [root, rootStat],
        [manifest.f, manifest.s],
        [evidence, evidenceStat],
        [data.f, data.s],
      ] as const)
        if (sig(await f.stat({ bigint: true })) !== sig(s))
          throw Error("Bundle changed; close and reopen it");
    }
    const hash = createHash("sha256"),
      block = Buffer.allocUnsafe(256 * 1024);
    let offset = 0;
    while (offset < entry.bytes) {
      const r = await data.f.read(
        block,
        0,
        Math.min(block.length, entry.bytes - offset),
        offset,
      );
      if (!r.bytesRead)
        throw Error("Public checkpoint changed during verification");
      hash.update(block.subarray(0, r.bytesRead));
      offset += r.bytesRead;
    }
    if (hash.digest("hex") !== entry.sha256)
      throw Error("Public checkpoint SHA-256 does not match manifest");
    await assertUnchanged();
    async function openData() {
      await assertUnchanged();
      // Deliberately follow this kernel-owned descriptor link, never a caller or
      // manifest path. The original descriptor stays open until viewer shutdown.
      const f = await open(
        `/proc/self/fd/${data.f.fd}`,
        constants.O_RDONLY | constants.O_NONBLOCK,
      );
      try {
        if (sig(await f.stat({ bigint: true })) !== sig(data.s))
          throw Error("Bundle changed");
        return { f, s: await f.stat() };
      } catch (e) {
        await f.close();
        throw e;
      }
    }
    const snapshot = await scanArchive("", m.sourceSessionId, openData);
    await assertUnchanged();
    for (const key of [
      "state",
      "issue",
      "validBytes",
      "totalBytes",
      "completeFrames",
      "gaps",
    ])
      if (
        JSON.stringify((snapshot.integrity as any)[key]) !==
        JSON.stringify(m.integrity[key])
      )
        throw Error(
          "Bundle integrity does not match its public checkpoint prefix",
        );
    snapshot.integrity.notice =
      "Salvaged bundle · read-only. Public checkpoint SHA-256 matches the manifest; private evidence and the separate export were not opened or verified. This is not authenticity or historical verification, and no live world or missing receipt was repaired. " +
      snapshot.integrity.notice;
    const id = m.sourceSessionId;
    const store = createRunStore("", {
      id,
      open: openData,
      assertUnchanged,
      snapshot: async () => {
        await assertUnchanged();
        return snapshot;
      },
    });
    return {
      id,
      store,
      integrity: snapshot.integrity,
      async close() {
        if (closed) return;
        closed = true;
        for (const f of [...handles].reverse()) await f.close();
      },
    };
  } catch (e) {
    closed = true;
    for (const f of handles.reverse()) await f.close().catch(() => {});
    throw e;
  }
}
export type BundleReview = Awaited<ReturnType<typeof openBundleReview>>;

// Strict loopback policy independent of live-server reverse-proxy overrides.
export function bundleRequestAllowed(req: Request) {
  const url = new URL(req.url),
    origin = req.headers.get("origin");
  return (
    ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname) &&
    (!origin || origin === url.origin) &&
    req.headers.get("sec-fetch-site") !== "cross-site"
  );
}
export async function createBundleReviewHandler(
  bundle: BundleReview,
  clientDir: string,
) {
  // Only these trusted application assets are exposed. No directory routing,
  // filesystem paths, manifest, raw evidence, pins, or input journals over HTTP.
  const html = await Bun.file(`${clientDir}/index.html`).text();
  if (!html.includes("<explorer-view>")) throw Error("Unsupported viewer HTML");
  const page = html.replace("<explorer-view>", "<explorer-view read-only>");
  const js = Bun.file(`${clientDir}/dist/explorer-app.js`);
  if (!(await js.exists())) throw Error("Build client assets first");
  return async (req: Request): Promise<Response> => {
    if (!bundleRequestAllowed(req))
      return new Response("Host/Origin is not permitted", { status: 403 });
    if (req.method !== "GET" && req.method !== "HEAD")
      return new Response("Read-only viewer; no game API", { status: 405 });
    const url = new URL(req.url),
      headers = {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "content-security-policy":
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      };
    if (url.pathname === "/")
      return new Response(null, {
        status: 302,
        headers: { ...headers, location: `/play?run=${bundle.id}` },
      });
    if (url.pathname === "/play")
      return new Response(req.method === "HEAD" ? null : page, {
        headers: { ...headers, "content-type": "text/html; charset=utf-8" },
      });
    if (url.pathname === "/dist/explorer-app.js")
      return new Response(req.method === "HEAD" ? null : js, {
        headers: {
          ...headers,
          "content-type": "text/javascript; charset=utf-8",
        },
      });
    if (url.pathname === "/runs" || url.pathname.startsWith("/runs/")) {
      try {
        const response = await bundle.store.handle(req);
        for (const [k, v] of Object.entries(headers))
          response.headers.set(k, v);
        return req.method === "HEAD"
          ? new Response(null, {
              status: response.status,
              headers: response.headers,
            })
          : response;
      } catch {
        return new Response("Bundle unavailable or changed; reopen it", {
          status: 409,
          headers,
        });
      }
    }
    return new Response(
      "Not found; no engine API or private evidence is served",
      { status: 404, headers },
    );
  };
}
