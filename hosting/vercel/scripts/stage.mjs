import { stage } from "./runtime-package.mjs";
import {stageOffline} from './stage-offline.mjs';
import './stage-validator.mjs';
import './stage-chronicle.mjs';
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const out = resolve(import.meta.dirname, "../public");
const pixel = resolve(root, "web/neohack.dev/public");
const dist = resolve(root, "lib/neonethack/dist");

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
// The function upload root is hosting/vercel. Bundle the exact shared format
// validator there instead of depending on files outside the deployment root.
await cp(pixel, out, { recursive: true });
const replayOrigin=process.env.PUBLIC_REPLAY_ORIGIN || '';
if(replayOrigin && !/^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\/?$/.test(replayOrigin))throw Error('PUBLIC_REPLAY_ORIGIN must be a public Blob store origin');
await writeFile(resolve(out,'replay-config.json'),JSON.stringify({base:replayOrigin}));
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
await stageOffline(out);
console.log("staged", out);
