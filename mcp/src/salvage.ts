// Explicit Linux operator utility. No engine/core imports, execution, repair,
// publication as a live world, or modifications to the source run.
import { constants } from "node:fs";
import {
  open,
  mkdir,
  opendir,
  realpath,
  lstat,
  unlink,
  rename,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  resolve,
  join,
  relative,
  isAbsolute,
  dirname,
  basename,
} from "node:path";
import { scanArchive, MAX_ARCHIVE_BYTES } from "./archive";
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BYTES = 10 * 1024 ** 3,
  MAX_ENTRIES = 20000,
  MAX_DEPTH = 32;
const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const sig = (s: any) =>
  [s.dev, s.ino, s.size, s.mode, s.nlink, s.mtimeNs, s.ctimeNs].join(":");
const inside = (root: string, path: string) => {
  const r = relative(root, path);
  return !r || (!isAbsolute(r) && r !== ".." && !r.startsWith("../"));
};
const at = (dir: FileHandle, name = "") =>
  `/proc/self/fd/${dir.fd}${name ? "/" + name : ""}`;
async function syncDir(path: string) {
  const f = await open(path, flags | constants.O_DIRECTORY);
  try {
    await f.sync();
  } finally {
    await f.close();
  }
}
async function writeNew(path: string, data: string) {
  const f = await open(path, "wx", 0o600);
  try {
    await f.writeFile(data);
    await f.chmod(0o400);
    await f.sync();
  } finally {
    await f.close();
  }
}
async function lock(lease: FileHandle) {
  // flock(2) belongs to the open file description inherited on fd 3. The
  // parent keeps that description open after this bounded helper exits.
  const program = Bun.which("flock");
  if (!program) throw Error("flock is required; no unlocked fallback");
  await new Promise<void>((ok, fail) => {
    const p = spawn(
      program,
      ["--exclusive", "--nonblock", "--conflict-exit-code", "75", "3"],
      { stdio: ["ignore", "ignore", "pipe", lease.fd] },
    );
    let error = "";
    p.stderr!.on("data", (chunk) => {
      error = (error + chunk).slice(-2048);
    });
    p.on("error", fail);
    p.on("exit", (code) =>
      code === 0
        ? ok()
        : fail(
            Error(
              code === 75
                ? "Source is busy; save and retire its owner first"
                : `Cannot lock source: ${error}`,
            ),
          ),
    );
  });
}
type Entry = {
  path: string;
  kind: "file" | "directory";
  bytes: number;
  mode: number;
  signature: string;
  sha256?: string;
};

export async function salvageRun(
  root: string,
  id: string,
  destination: string,
  options: { confirm: boolean },
) {
  if (options?.confirm !== true)
    throw Error("Explicit confirmation is required");
  if (process.platform !== "linux")
    throw Error(
      "Preserved-copy salvage currently requires Linux /proc and flock",
    );
  if (!ID.test(id)) throw Error("Invalid source id");
  const base = await realpath(resolve(root)),
    source = join(base, id),
    parent = await realpath(dirname(resolve(destination))),
    dest = join(parent, basename(resolve(destination)));
  if (inside(base, dest) || inside(dest, base))
    throw Error("Destination must be outside the session root");
  if ((await realpath(source)) !== source)
    throw Error("Source must be a direct run directory");
  const dir = await open(source, flags | constants.O_DIRECTORY);
  let lease: FileHandle | undefined,
    created = false;
  const entries: Entry[] = [];
  let total = 0;
  try {
    const initial = await dir.stat({ bigint: true });
    // Never create a missing lease in the original, and never bypass an owner.
    lease = await open(at(dir, ".lease"), flags);
    const ls = await lease.stat({ bigint: true });
    if (!ls.isFile() || ls.nlink !== 1n)
      throw Error("Source lease must be a regular single-link file");
    await lock(lease);
    if (sig(await lstat(at(dir, ".lease"), { bigint: true })) !== sig(ls))
      throw Error("Source lease changed");
    const preview = await scanArchive(at(dir, "perceptions.jsonl"), id);
    if (preview.integrity.state === "complete")
      throw Error(
        "Checkpoint stream is complete; no damaged-prefix salvage is needed",
      );
    await mkdir(dest, { mode: 0o700 });
    created = true; // Exclusive; never replace an existing bundle.
    await syncDir(parent);
    await writeNew(
      join(dest, "INCOMPLETE.json"),
      JSON.stringify({
        format: "neonethack.salvageInProgress",
        version: 1,
        sourceSessionId: id,
        notice:
          "Use only a bundle with a complete manifest.json. Failed/partial copies are not a recovered recording.",
      }) + "\n",
    );
    const evidence = join(dest, "evidence");
    await mkdir(evidence, { mode: 0o700 });
    async function walk(
      folder: FileHandle,
      sub: string,
      depth: number,
      verify = false,
    ) {
      if (depth > MAX_DEPTH)
        throw Error("Source directory depth limit exceeded");
      const listing = await opendir(at(folder), { bufferSize: 32 });
      for await (const entry of listing) {
        const name = entry.name;
        if (name.includes("/") || name === "." || name === "..")
          throw Error("Unsafe source name");
        const path = sub ? `${sub}/${name}` : name;
        const f = await open(at(folder, name), flags);
        try {
          const s = await f.stat({ bigint: true });
          // Native engine pins intentionally share a versioned per-root cache
          // inode. Copy that one known artifact into an independent file; all
          // journals/metadata and other files still require a single link.
          if (
            !s.isDirectory() &&
            (!s.isFile() || (s.nlink !== 1n && path !== "engine"))
          )
            throw Error(`Unsafe source entry: ${path}`);
          if (verify) {
            const known = catalog.get(path);
            if (!known || known.signature !== sig(s))
              throw Error(`Source changed: ${path}`);
            checked.add(path);
            if (s.isDirectory()) await walk(f, path, depth + 1, true);
          } else {
            if (entries.length >= MAX_ENTRIES)
              throw Error("Source entry count limit exceeded");
            const row: Entry = {
              path,
              kind: s.isDirectory() ? "directory" : "file",
              bytes: s.isDirectory() ? 0 : Number(s.size),
              mode: Number(s.mode & 0o7777n),
              signature: sig(s),
            };
            entries.push(row);
            if (s.isDirectory()) {
              await mkdir(join(evidence, path), { mode: 0o700 });
              await walk(f, path, depth + 1);
              await syncDir(join(evidence, path));
            } else {
              if (
                s.size > BigInt(MAX_ARCHIVE_BYTES) ||
                (total += row.bytes) > MAX_BYTES
              )
                throw Error("Source copy byte limit exceeded");
              const target = await open(join(evidence, path), "wx", 0o600),
                hash = createHash("sha256");
              try {
                const block = Buffer.allocUnsafe(256 * 1024);
                let offset = 0;
                while (offset < row.bytes) {
                  const { bytesRead } = await f.read(
                    block,
                    0,
                    Math.min(block.length, row.bytes - offset),
                    offset,
                  );
                  if (!bytesRead) throw Error(`Source shortened: ${path}`);
                  const bytes = block.subarray(0, bytesRead);
                  hash.update(bytes);
                  await target.writeFile(bytes);
                  offset += bytesRead;
                }
                await target.chmod(0o400);
                await target.sync();
                row.sha256 = hash.digest("hex");
              } finally {
                await target.close();
              }
            }
          }
          if (sig(await f.stat({ bigint: true })) !== sig(s))
            throw Error(`Source changed while copying: ${path}`);
        } finally {
          await f.close();
        }
      }
    }
    // These are populated after the initial walk, before its verification pass.
    const catalog = new Map<string, Entry>(),
      checked = new Set<string>();
    await walk(dir, "", 0);
    for (const row of entries) catalog.set(row.path, row);
    await walk(dir, "", 0, true);
    if (
      checked.size !== entries.length ||
      sig(await dir.stat({ bigint: true })) !== sig(initial) ||
      sig(await lstat(source, { bigint: true })) !== sig(initial)
    )
      throw Error("Source tree changed; incomplete copy retained");
    if (sig(await lstat(at(dir, ".lease"), { bigint: true })) !== sig(ls))
      throw Error("Source lease changed");
    await syncDir(evidence);
    const snapshot = await scanArchive(join(evidence, "perceptions.jsonl"), id);
    if (
      JSON.stringify(snapshot.integrity) !== JSON.stringify(preview.integrity)
    )
      throw Error("Copied archive differs from the locked source snapshot");
    let review: null | { file: string; sha256: string; bytes: number } = null;
    if (snapshot.rows.length) {
      const file = "review.nh-run.jsonl",
        f = await open(join(dest, file), "wx", 0o600),
        input = await open(join(evidence, "perceptions.jsonl"), flags),
        hash = createHash("sha256");
      const header = Buffer.from(
        JSON.stringify({
          format: "neonethack.recordingManifest",
          version: 1,
          integrity: {
            ...snapshot.integrity,
            notice:
              "Salvaged read-only prefix. Original damaged bytes and all private state are preserved in the separate evidence bundle. No engine ran; no live world or missing receipt was repaired. " +
              snapshot.integrity.notice,
          },
        }) + "\n",
      );
      try {
        hash.update(header);
        await f.writeFile(header);
        let offset = 0;
        const block = Buffer.allocUnsafe(256 * 1024);
        while (offset < snapshot.integrity.validBytes) {
          const { bytesRead } = await input.read(
            block,
            0,
            Math.min(block.length, snapshot.integrity.validBytes - offset),
            offset,
          );
          if (!bytesRead)
            throw Error("Preserved evidence unexpectedly shortened");
          const bytes = block.subarray(0, bytesRead);
          hash.update(bytes);
          await f.writeFile(bytes);
          offset += bytesRead;
        }
        await f.chmod(0o400);
        await f.sync();
        review = {
          file,
          bytes: header.length + snapshot.integrity.validBytes,
          sha256: hash.digest("hex"),
        };
      } finally {
        await input.close();
        await f.close();
      }
    }
    const manifest = {
      format: "neonethack.salvageBundle",
      version: 1,
      state: "complete",
      createdAt: Date.now(),
      sourceSessionId: id,
      sourcePath: source,
      readOnly: true,
      engineExecuted: false,
      liveRecovery: false,
      integrity: snapshot.integrity,
      review,
      entries,
      bytes: total,
      notice:
        "Byte-preserved evidence and a structurally validated prefix, not proof of historical authenticity. Reservations and uncertain execution remain unresolved. Do not install evidence as a live session or clear its boundary flags.",
    };
    // The completion manifest is the commit marker, written last and fsynced.
    await syncDir(dest);
    await writeNew(
      join(dest, ".manifest.pending.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    await rename(
      join(dest, ".manifest.pending.json"),
      join(dest, "manifest.json"),
    );
    await syncDir(dest);
    await syncDir(parent);
    return { destination: dest, ...manifest };
  } catch (error) {
    if (created) await unlink(join(dest, "manifest.json")).catch(() => {});
    if (created)
      await writeNew(
        join(dest, "FAILED.json"),
        JSON.stringify({
          state: "failed",
          error: String(error),
          notice:
            "Incomplete generated bundle retained for diagnosis; source bytes were not changed.",
        }) + "\n",
      )
        .then(() => syncDir(dest))
        .catch(() => {});
    throw error;
  } finally {
    await lease?.close();
    await dir.close();
  }
}
