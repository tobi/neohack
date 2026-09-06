import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const out = resolve(import.meta.dirname, "../public");
const pixel = resolve(root, "example/pixel-bun/public");
const dist = resolve(root, "lib/neonethack/dist");
const cfStage = resolve(root, "hosting/cloudflare/scripts/runtime-package.mjs");

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(pixel, out, { recursive: true });
await mkdir(resolve(out, "runtime"), { recursive: true });
for (const part of ["typescript", "mcp", "protocol"]) {
  await cp(resolve(dist, part), resolve(out, "runtime", part), { recursive: true });
}
try {
  const { stage } = await import(cfStage);
  await stage(resolve(out, "runtime/wasm"));
} catch {
  await cp(resolve(dist, "wasm"), resolve(out, "runtime/wasm"), { recursive: true });
}

const index = resolve(out, "index.html");
let html = await readFile(index, "utf8");
if (!html.includes("/_vercel/speed-insights")) {
  html = html.replace(
    "</head>",
    `    <script type="module" src="/_vercel/insights/script.js" defer></script>\n    <script type="module" src="/_vercel/speed-insights/script.js" defer></script>\n  </head>`,
  );
  await writeFile(index, html);
}
console.log("staged", out);
