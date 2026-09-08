import { readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

export async function stageOffline(root) {
  const current = JSON.parse(
    await readFile(resolve(root, "runtime/wasm/current.json"), "utf8"),
  );
  const dog = await readFile(resolve(root, "art/dog.png"));
  await writeFile(
    resolve(root, "icon.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 192 192"><rect width="192" height="192" rx="32" fill="#171d21"/><image x="32" y="32" width="128" height="128" style="image-rendering:pixelated" href="data:image/png;base64,${dog.toString("base64")}"/></svg>`,
  );
  const paths = [];
  async function walk(dir, prefix) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = prefix + "/" + entry.name;
      if (entry.isDirectory()) await walk(resolve(dir, entry.name), path);
      else if (
        /\.(?:js|mjs|wasm|data|json|css|html|png|svg|woff2|webm|ogg|mp3|wav|webmanifest)$/.test(
          entry.name,
        )
      )
        paths.push(path);
    }
  }
  for (const name of [
    "build",
    "art",
    "audio",
    "fonts",
    "bots",
    "runtime/typescript",
    "runtime/mcp",
    "runtime/protocol",
    "runtime/wasm/" + current.buildId,
  ]) {
    try {
      await walk(resolve(root, name), "/" + name);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  for (const name of [
    "index.html",
    "style.css",
    "studio.css",
    "character-sheet.css",
    "offline.js",
    "icon.svg",
    "manifest.webmanifest",
    "replay-config.json",
    "runtime/wasm/current.json",
    "runtime/wasm/worker-port.mjs",
  ])
    paths.push("/" + name);
  // Only successful public-file reads are included. Account and run APIs are
  // deliberately absent, as are old packages not needed by the current shell.
  const assets = [...new Set(paths)].sort(),
    hash = createHash("sha256");
  for (const path of assets) {
    hash.update(path);
    hash.update(await readFile(resolve(root, "." + path)));
  }
  const config = { version: hash.digest("hex").slice(0, 24), assets };
  const worker = await readFile(resolve(root, "service-worker.js"), "utf8");
  await writeFile(
    resolve(root, "service-worker.js"),
    worker.replace(
      "const CONFIG = null; // NE0HACK_OFFLINE_CONFIG",
      "const CONFIG = " + JSON.stringify(config) + ";",
    ),
  );
}
