import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../public");
for (const file of [
  "index.html",
  "dashboard.html",
  "replays/index.html",
  "build/replay-page.js",
  "400.html",
  "404.html",
  "500.html",
  "dashboard.js",
  "component/index.html",
  "login/index.html",
  "bots/index.html",
  "bots/sandbox.html",
  "build/app.js",
  "service-worker.js",
  "offline.js",
  "manifest.webmanifest",
]) {
  if (!(await stat(resolve(root, file))).size)
    throw Error(`Missing staged asset: ${file}`);
}
const offline = await readFile(resolve(root, "service-worker.js"), "utf8");
if (offline.includes("const CONFIG = null")) throw Error("Offline inventory was not staged");
if (!(await stat(resolve(root, "../.generated/protocol-recording.mjs"))).size)
  throw Error("Missing function-local input format validator");
for (const module of ["examples/chronicle/replay.mjs", "examples/chronicle/generate.mjs", "lib/neonethack/dist/typescript/wasm.js",
  "lib/neonethack/wasm/core-worker.mjs", "lib/neonethack/wasm/engine-worker.mjs", "lib/neonethack/wasm/worker-port.mjs", "lib/neonethack/wasm/replay-evidence.mjs"])
  if (!(await stat(resolve(root, "../.generated/chronicle", module))).size)
    throw Error("Missing function-local chronicle module: " + module);
const current = JSON.parse(
  await readFile(resolve(root, "runtime/wasm/current.json"), "utf8"),
);
if (!/^[a-f0-9]{64}$/.test(current.buildId))
  throw Error("Invalid current runtime");
const manifest = JSON.parse(
  await readFile(
    resolve(root, `runtime/wasm/${current.buildId}/manifest.json`),
    "utf8",
  ),
);
if (manifest.buildId !== current.buildId)
  throw Error("Runtime pointer mismatch");
console.log("Verified staged website, dashboard, workshop and pinned runtime.");
