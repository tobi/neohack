import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { stageChronicle } from "../scripts/stage-chronicle.mjs";

test("clean chronicle staging includes multiline worker URLs and removes stale dependencies", async (t) => {
  const parent = await mkdtemp("/tmp/neohack-chronicle-stage-");
  let transport;
  t.after(async () => {
    try {
      await transport?.close();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
  await writeFile(join(parent, "package.json"), '{"type":"module"}');
  const target = join(parent, "staged");
  await mkdir(target);
  await writeFile(join(target, "obsolete.mjs"), 'throw Error("obsolete")');
  const staged = await stageChronicle(target);
  await assert.rejects(readFile(join(target, "obsolete.mjs")), {
    code: "ENOENT",
  });
  for (const name of [
    "core-worker",
    "engine-worker",
    "checkpoint-worker",
    "worker-port",
    "replay-evidence",
  ])
    assert.ok(
      staged.includes(`lib/neonethack/wasm/${name}.mjs`),
      `${name} must ship in a fresh deployment`,
    );
  const { WasmTransport } = await import(
    pathToFileURL(join(target, "lib/neonethack/dist/typescript/wasm.js"))
  );
  transport = await WasmTransport.create({
    storage: { kind: "memory" },
    workerUrl: pathToFileURL(
      join(target, "lib/neonethack/wasm/core-worker.mjs"),
    ),
    runtimeUrl: pathToFileURL(
      resolve(import.meta.dirname, "../../../lib/neonethack/dist/wasm") + "/",
    ).href,
  });
  assert.match(transport.buildId, /^[a-f0-9]{64}$/);
});
