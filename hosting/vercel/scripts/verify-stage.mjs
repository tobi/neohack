import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../public");
for (const file of [
  "index.html",
  "dashboard.html",
  "400.html",
  "404.html",
  "500.html",
  "dashboard.js",
  "component/index.html",
  "login/index.html",
  "bots/index.html",
  "bots/sandbox.html",
  "build/app.js",
]) {
  if (!(await stat(resolve(root, file))).size)
    throw Error(`Missing staged asset: ${file}`);
}
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
