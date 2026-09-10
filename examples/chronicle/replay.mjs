import {
  readFile,
  writeFile,
  mkdir,
  rename,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { WasmTransport } from "../../lib/neonethack/dist/typescript/wasm.js";
import {
  inputManifest,
  inputRecords,
} from "../../lib/neonethack/wasm/protocol-reader.mjs";
const hash = (b) => createHash("sha256").update(b).digest("hex");
async function eachWindow(values, action) {
  for (let i = 0; i < values.length; i += 6) {
    // Settle the entire window before cleaning its staging directory on error.
    const results = await Promise.allSettled(
      values.slice(i, i + 6).map(action),
    );
    const failed = results.find((r) => r.status === "rejected");
    if (failed) throw failed.reason;
  }
}

export async function packageAt(
  id,
  existing,
  origin = "https://neohack.dev/",
  { signal } = {},
) {
  signal?.throwIfAborted();
  if (existing) {
    const dir = resolve(existing),
      m = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
    await check(dir, m, id);
    return dir;
  }
  const parent = join(tmpdir(), "neohack-chronicle-runtimes");
  await mkdir(parent, { recursive: true });
  const dir = join(parent, id);
  try {
    const m = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
    await check(dir, m, id);
    return dir;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const base = new URL(`runtime/wasm/${id}/`, origin).href;
  const get = async (name) => {
    const r = await fetch(base + name, {
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000),
    });
    if (!r.ok) throw Error(`Pinned runtime unavailable (${r.status})`);
    const b = Buffer.from(await r.arrayBuffer());
    if (b.length > 32 * 1024 * 1024) throw Error("Runtime asset too large");
    return b;
  };
  const m = JSON.parse((await get("manifest.json")).toString("utf8"));
  validate(m, id);
  const staging = await mkdtemp(join(parent, "incoming-"));
  try {
    // Only the official, exact runtime package supplies executable code.
    await eachWindow(Object.entries(m.files), async ([name, digest]) => {
      const b = await get(name);
      if (hash(b) !== digest) throw Error("Runtime checksum differs");
      await writeFile(join(staging, name), b);
    });
    await eachWindow(
      [
        "NETHACK-LICENSE.txt",
        "LUA-LICENSE.txt",
        "EMSCRIPTEN-LICENSE.txt",
        "MUSL-COPYRIGHT.txt",
        "COMPILER-RT-LICENSE.txt",
        "LLVM-LIBC-LICENSE.txt",
      ],
      async (name) => writeFile(join(staging, name), await get(name)),
    );
    await writeFile(join(staging, "manifest.json"), JSON.stringify(m));
    try {
      await rename(staging, dir);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
      await check(dir, m, id);
    }
    return dir;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
function validate(m, id) {
  if (
    m?.version !== 1 ||
    m.buildId !== id ||
    !m.files ||
    Object.keys(m.files).length > 40 ||
    hash(JSON.stringify(m.files)) !== id ||
    Object.entries(m.files).some(
      ([name, digest]) =>
        !/^[-\w]+\.(?:mjs|wasm|data)$/.test(name) ||
        !/^[a-f0-9]{64}$/.test(digest),
    )
  )
    throw Error("Pinned runtime manifest differs");
  for (const name of [
    "core-worker.mjs",
    "neonethack-core.wasm",
    "neonethack-engine.wasm",
    "neonethack-engine.data",
  ])
    if (!m.files[name]) throw Error("Incomplete runtime package");
}
async function check(dir, m, id) {
  validate(m, id);
  for (const [name, digest] of Object.entries(m.files))
    if (hash(await readFile(join(dir, name))) !== digest)
      throw Error("Cached runtime checksum differs");
}

/** One pass, all authoritative inputs. Checkpoints cannot substitute for the
 * incidents before them. No new observation recording or live game service.
 * `runtime` is a local exact package directory (or a function of the pin);
 * `runtimeOrigin` is where the official package is fetched from otherwise.
 * `lookup(fn)` runs after the replay with the pinned engine's free encyclopedia. */
export async function collectReplay(
  url,
  collector,
  {
    runtime,
    runtimeOrigin,
    signal,
    lookup,
    maxInputs = Infinity,
    onProgress,
    onTiming,
  } = {},
) {
  const started = performance.now();
  const timing = {
    mode: "batch-evidence",
    inputs: 0,
    completedInputs: 0,
    chunks: 0,
    compressedBytes: 0,
    batches: 0,
    manifestMs: 0,
    runtimeMs: 0,
    downloadWaitMs: 0,
    replayMs: 0,
    digestMs: 0,
    loreMs: 0,
    closeMs: 0,
  };
  const timed = async (field, action) => {
    const start = performance.now();
    try {
      return await action();
    } finally {
      timing[field] += performance.now() - start;
    }
  };
  let transport, records;
  const downloads = new AbortController();
  const readingSignal = signal
    ? AbortSignal.any([signal, downloads.signal])
    : downloads.signal;
  try {
    const source = new URL(url);
    if (!["https:", "http:"].includes(source.protocol))
      throw Error("Provide a static HTTP(S) input manifest URL");
    const manifest = await timed("manifestMs", () =>
      inputManifest(source, readingSignal),
    );
    Object.assign(timing, {
      inputs: manifest.count,
      chunks: manifest.chunks.length,
      compressedBytes: manifest.chunks.reduce((n, c) => n + c.bytes, 0),
    });
    if (manifest.count > maxInputs)
      throw Error("This run is longer than the chronicler can replay");
    transport = await timed("runtimeMs", async () => {
      const dir = await packageAt(
        manifest.buildId,
        typeof runtime === "function"
          ? await runtime(manifest.buildId)
          : runtime,
        runtimeOrigin,
        { signal: readingSignal },
      );
      return WasmTransport.create({
        storage: { kind: "memory" },
        runtimeUrl: pathToFileURL(dir + "/").href,
        // Current transport/batching code with the archive's exact compiler/data
        // package, as in the viewer. Never swap its core, engine or game data.
        workerUrl: new URL(
          "../../lib/neonethack/wasm/core-worker.mjs",
          import.meta.url,
        ),
        playbackArchive: { manifest, url: source.href },
      });
    });
    if (transport.buildId !== manifest.buildId)
      throw Error("Replay requires its exact engine package");
    onProgress?.(0, manifest.count);
    records = inputRecords(manifest, source, { signal: readingSignal });
    let batch = [];
    const flush = async () => {
      if (!batch.length) return;
      signal?.throwIfAborted();
      const evidence = await timed("replayMs", () =>
        transport.playbackEvidence(batch),
      );
      if (
        evidence.format !== "neohack.replay-evidence" ||
        evidence.version !== 1 ||
        evidence.from !== timing.completedInputs ||
        evidence.count !== batch.length ||
        evidence.entries.length !== batch.length
      )
        throw Error("Replay evidence batch differs");
      await timed("digestMs", () => {
        for (let i = 0; i < evidence.entries.length; i++) {
          if (evidence.entries[i].index !== batch[i].index)
            throw Error("Replay evidence order differs");
          collector.addEvidence(evidence.entries[i]);
        }
      });
      timing.completedInputs += batch.length;
      timing.batches++;
      batch = [];
      onProgress?.(timing.completedInputs, manifest.count);
    };
    for (;;) {
      signal?.throwIfAborted();
      const { value: record, done } = await timed("downloadWaitMs", () =>
        records.next(),
      );
      if (done) break;
      if (record.index === 0) {
        const p = record.request.params;
        for (const k of ["name", "role", "race"])
          if (typeof p[k] === "string" && !collector.hero[k])
            collector.hero[k] = p[k].slice(0, 80);
      }
      batch.push(record);
      if (batch.length === 128) await flush();
    }
    await flush();
    const digest = await timed("digestMs", () => collector.finish());
    if (lookup) {
      await timed("loreMs", async () => {
        // The replayed game has usually ended, and lore needs a live boundary. A
        // throwaway session in the same isolated package reads the same pinned
        // encyclopedia; it is never recorded, uploaded or shown as the hero's run.
        const created = await transport.send({
          version: 1,
          method: "session.create",
          params: { name: "Chronicler", role: "valkyrie", seed: 1 },
        });
        if (typeof created?.sessionId !== "string")
          throw Error("The pinned encyclopedia is unavailable");
        await lookup((name) =>
          transport.send({
            version: 1,
            method: "session.lookup",
            params: {
              sessionId: created.sessionId,
              name: String(name).slice(0, 255),
            },
          }),
        );
      });
    }
    return digest;
  } finally {
    downloads.abort();
    try {
      await timed("closeMs", async () => {
        try { await records?.return(); }
        finally { await transport?.close(); }
      });
    } finally {
      onTiming?.({ ...timing, totalMs: performance.now() - started });
    }
  }
}
