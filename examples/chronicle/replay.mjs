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
import { isFullReply } from "./digest.mjs";
const hash = (b) => createHash("sha256").update(b).digest("hex");

async function packageAt(id, existing, origin = "https://neohack.dev/") {
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
      signal: AbortSignal.timeout(30000),
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
    for (const [name, digest] of Object.entries(m.files)) {
      const b = await get(name);
      if (hash(b) !== digest) throw Error("Runtime checksum differs");
      await writeFile(join(staging, name), b);
    }
    for (const name of [
      "NETHACK-LICENSE.txt",
      "LUA-LICENSE.txt",
      "EMSCRIPTEN-LICENSE.txt",
      "MUSL-COPYRIGHT.txt",
      "COMPILER-RT-LICENSE.txt",
      "LLVM-LIBC-LICENSE.txt",
    ])
      await writeFile(join(staging, name), await get(name));
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
 * incidents before them. No observation recording or server-side game engine.
 * `runtime` is a local exact package directory (or a function of the pin);
 * `runtimeOrigin` is where the official package is fetched from otherwise.
 * `lookup(fn)` runs after the replay with the pinned engine's free encyclopedia. */
export async function collectReplay(
  url,
  collector,
  { runtime, runtimeOrigin, signal, lookup, maxInputs = Infinity } = {},
) {
  const source = new URL(url);
  if (!["https:", "http:"].includes(source.protocol))
    throw Error("Provide a static HTTP(S) input manifest URL");
  const manifest = await inputManifest(source, signal);
  if (manifest.count > maxInputs)
    throw Error("This run is longer than the chronicler can replay");
  const dir = await packageAt(
    manifest.buildId,
    typeof runtime === "function" ? await runtime(manifest.buildId) : runtime,
    runtimeOrigin,
  );
  const base = pathToFileURL(dir + "/");
  const transport = await WasmTransport.create({
    storage: { kind: "memory" },
    runtimeUrl: base.href,
    workerUrl: new URL("core-worker.mjs", base),
  });
  try {
    if (transport.buildId !== manifest.buildId)
      throw Error("Replay requires its exact engine package");
    for await (const record of inputRecords(manifest, source, { signal })) {
      if (record.index === 0) {
        const p = record.request.params;
        for (const k of ["name", "role", "race"])
          if (typeof p[k] === "string" && !collector.hero[k])
            collector.hero[k] = p[k].slice(0, 80);
      }
      const reply = await transport.playback(record);
      // Decision prompts and cancelled actions are full replies at the same
      // revision; the digest counts them as ignored rather than as new events.
      if (!collector.add(reply) && !isFullReply(reply))
        throw Error("An archived input did not yield a full public reply");
    }
    const digest = collector.finish();
    if (lookup) {
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
    }
    return digest;
  } finally {
    await transport.close();
  }
}
