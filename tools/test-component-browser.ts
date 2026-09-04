// Isolated CI browser fixture. Never attach to a user's browser/profile or API.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
const root = resolve(import.meta.dir, ".."),
  client = join(root, "client/dist/standalone");
const chrome =
  process.env.CHROME_BIN ?? Bun.which("chromium") ?? Bun.which("google-chrome");
if (!chrome)
  throw Error("Install Chromium/Chrome or set CHROME_BIN for browser tests");
const profile = await mkdtemp(join(tmpdir(), "nh-component-chrome-"));
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url),
      path = resolve(client, "." + decodeURIComponent(url.pathname));
    if (
      req.method !== "GET" ||
      !path.startsWith(client + sep) ||
      /\/(mcp|runs|reconstructions)(\/|$)/.test(url.pathname)
    )
      return new Response("No game API in component fixture", { status: 404 });
    const file = Bun.file(path);
    return (await file.exists())
      ? new Response(file)
      : new Response("Not found", { status: 404 });
  },
});
const proc = Bun.spawn(
  [
    chrome,
    "--headless=new",
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-extensions",
    "--disable-dev-shm-usage",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "about:blank",
  ],
  { stdout: "ignore", stderr: "pipe" },
);
// Bounded diagnostics: neither a full pipe nor an orphaned writer can hang cleanup.
let diagnostic = "";
const reader = proc.stderr.getReader(),
  decoder = new TextDecoder();
const diagnostics = (async () => {
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      diagnostic = (diagnostic + decoder.decode(value, { stream: true })).slice(
        -65536,
      );
    }
  } catch {}
})();
try {
  const deadline = performance.now() + 20000;
  let port = "",
    browserPath = "";
  while (performance.now() < deadline) {
    try {
      const lines = (
        await readFile(join(profile, "DevToolsActivePort"), "utf8")
      )
        .trim()
        .split("\n");
      if (
        /^\d+$/.test(lines[0]) &&
        /^\/devtools\/browser\/[a-z0-9-]+$/i.test(lines[1] ?? "")
      ) {
        port = lines[0];
        browserPath = lines[1];
        break;
      }
    } catch {}
    if (proc.exitCode !== null) throw Error(`Chrome exited: ${diagnostic}`);
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!port || proc.exitCode !== null)
    throw Error("Chrome did not create its isolated debugging endpoint");
  const version = await (
    await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(5000),
    })
  ).json();
  if (new URL(version.webSocketDebuggerUrl).pathname !== browserPath)
    throw Error("Refusing to attach to a browser not owned by this fixture");
  const test = Bun.spawn(
    [process.execPath, join(root, "client/tests/renderer-browser.ts")],
    {
      cwd: root,
      env: {
        ...process.env,
        APP_URL: `http://127.0.0.1:${server.port}`,
        CDP_URL: `http://127.0.0.1:${port}`,
        COMPONENT_ONLY: "1",
        COMPONENT_DEMO: "/demo.html",
        COMPONENT_BUNDLE: "/nh-map3d.js",
        KEEP_BROWSER_TAB: "0",
        EVIDENCE_DIR:
          process.env.EVIDENCE_DIR ?? "/tmp/neonethack-component-evidence",
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const timeout = setTimeout(() => {
    if (test.exitCode === null) test.kill("SIGKILL");
  }, 120000);
  try {
    if (await test.exited)
      throw Error("Standalone browser tests failed or exceeded two minutes");
  } finally {
    clearTimeout(timeout);
  }
} finally {
  server.stop(true);
  if (proc.exitCode === null) proc.kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    proc.exited,
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        if (proc.exitCode === null) proc.kill("SIGKILL");
        resolve();
      }, 5000);
    }),
  ]);
  clearTimeout(timer);
  await proc.exited;
  await reader.cancel().catch(() => {});
  await diagnostics;
  reader.releaseLock();
  await rm(profile, { recursive: true, force: true });
}
