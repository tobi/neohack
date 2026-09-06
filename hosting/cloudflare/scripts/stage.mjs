import { stage } from "./runtime-package.mjs";
import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const site = resolve(import.meta.dirname, "../site");
const pixel = resolve(root, "example/pixel-bun/public");
const dist = resolve(root, "lib/neonethack/dist");

await rm(site, { recursive: true, force: true });
await mkdir(site, { recursive: true });
await cp(pixel, site, { recursive: true });
await mkdir(resolve(site, "runtime"), { recursive: true });
for (const part of ["typescript", "mcp", "protocol"]) {
  await cp(resolve(dist, part), resolve(site, "runtime", part), { recursive: true });
}
await stage(resolve(site, "runtime/wasm"));
console.log("staged", site);
