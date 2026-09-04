import { readFile } from "node:fs/promises";
import { join } from "node:path";
// A port file can precede a responsive CDP endpoint on a busy runner. Retry
// readiness, never identity mismatches; do not attach to an unrelated browser.
export async function waitForOwnedBrowser(
  profile: string,
  exited: () => boolean,
  options: {
    timeoutMs?: number;
    pollMs?: number;
    requestTimeoutMs?: number;
  } = {},
) {
  const deadline = performance.now() + (options.timeoutMs ?? 45000);
  let detail = "port file not ready";
  while (performance.now() < deadline) {
    if (exited()) throw Error("Owned Chrome exited before CDP was ready");
    let lines: string[] = [];
    try {
      lines = (await readFile(join(profile, "DevToolsActivePort"), "utf8"))
        .trim()
        .split("\n");
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
    const [port, path] = lines;
    if (
      /^\d+$/.test(port ?? "") &&
      Number(port) > 0 &&
      Number(port) <= 65535 &&
      /^\/devtools\/browser\/[a-z0-9-]+$/i.test(path ?? "")
    ) {
      let version: any;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(
            Math.max(
              1,
              Math.min(
                options.requestTimeoutMs ?? 2000,
                Math.ceil(deadline - performance.now()),
              ),
            ),
          ),
        });
        if (response.ok) version = await response.json();
        else detail = `CDP HTTP ${response.status}`;
      } catch (error) {
        detail = String(error);
      }
      if (version) {
        if (
          typeof version.webSocketDebuggerUrl !== "string" ||
          new URL(version.webSocketDebuggerUrl).pathname !== path
        )
          throw Error(
            "Refusing to attach to a browser not owned by this fixture",
          );
        if (exited())
          throw Error("Owned Chrome exited while checking CDP identity");
        return `http://127.0.0.1:${port}`;
      }
    }
    await new Promise((r) =>
      setTimeout(
        r,
        Math.min(
          options.pollMs ?? 50,
          Math.max(0, deadline - performance.now()),
        ),
      ),
    );
  }
  throw Error(`Owned Chrome CDP readiness exceeded its deadline: ${detail}`);
}
