import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { ROOT } from "./bridge-harness";
export async function startBundleCLI(
  bundle: string,
  env: Record<string, string> = {},
) {
  const proc = spawn(
    process.execPath,
    [join(ROOT, "tools/review-bundle.ts"), bundle, "--port", "0"],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } },
  );
  let diagnostic = "";
  proc.stderr.on("data", (b) => (diagnostic = (diagnostic + b).slice(-65536)));
  const exited = new Promise<void>((r) => proc.once("exit", () => r()));
  async function stop() {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    proc.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([
        exited,
        new Promise<void>((r) => {
          timer = setTimeout(() => {
            if (proc.exitCode === null && proc.signalCode === null)
              proc.kill("SIGKILL");
            r();
          }, 5000);
        }),
      ]);
      await exited;
    } finally {
      clearTimeout(timer!);
    }
  }
  const lines = createInterface({ input: proc.stdout });
  let timer: ReturnType<typeof setTimeout>;
  try {
    const ready: any = await new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(Error("Bundle viewer startup timed out: " + diagnostic)),
        15000,
      );
      proc.once("error", reject);
      proc.once("exit", () =>
        reject(Error("Bundle viewer exited: " + diagnostic)),
      );
      lines.once("line", (line) => {
        try {
          resolve(JSON.parse(line));
        } catch (e) {
          reject(e);
        }
      });
    });
    return { proc, url: ready.url, ready, stop, diagnostic: () => diagnostic };
  } catch (e) {
    await stop();
    throw e;
  } finally {
    clearTimeout(timer!);
    lines.close();
  }
}
