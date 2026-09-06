import { stage } from "./runtime-package.mjs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const out = resolve(import.meta.dirname, "../public");
const pixel = resolve(root, "web/neohack.dev/public");
const dist = resolve(root, "lib/neonethack/dist");

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(pixel, out, { recursive: true });
await mkdir(resolve(out, "runtime"), { recursive: true });
for (const part of ["typescript", "mcp", "protocol"]) {
  await cp(resolve(dist, part), resolve(out, "runtime", part), { recursive: true });
}
await stage(resolve(out, "runtime/wasm"));

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
