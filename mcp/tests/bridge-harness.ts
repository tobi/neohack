import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
export const ROOT = resolve(import.meta.dir, "../..");
export const testDirectory = (name = "lifecycle") =>
  mkdtempSync(`${tmpdir()}/nh-${name}-`);

export class TestBridge {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly exited: Promise<void>;
  private waiters: {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];
  private diagnostics = "";
  private dead = false;
  constructor(
    readonly sessions: string,
    environment: Record<string, string> = {},
  ) {
    this.proc = spawn(
      process.env.NHXCLI ?? `${ROOT}/mcp/bin/nhxcli`,
      [
        environment.ENGINE_CMD ??
          process.env.ENGINE_CMD ??
          `${ROOT}/upstream/playground/nethack`,
        `${ROOT}/upstream/playground`,
        sessions,
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...environment },
      },
    );
    this.proc.stderr.on(
      "data",
      (b) => (this.diagnostics = (this.diagnostics + b).slice(-16384)),
    );
    createInterface({ input: this.proc.stdout }).on("line", (line) => {
      const w = this.waiters.shift();
      if (!w) return;
      clearTimeout(w.timer);
      try {
        w.resolve(JSON.parse(line));
      } catch (e) {
        w.reject(e as Error);
      }
    });
    this.exited = new Promise((resolve) => {
      this.proc.on("exit", (code) => {
        this.dead = true;
        for (const w of this.waiters.splice(0)) {
          clearTimeout(w.timer);
          w.reject(Error(`Bridge exited (${code}): ${this.diagnostics}`));
        }
        resolve();
      });
    });
  }
  call(tool: string, args: any = {}): Promise<any> {
    return this.callRaw(JSON.stringify({ tool, ...args }));
  }
  callRaw(request: string | Buffer): Promise<any> {
    if (this.dead) return Promise.reject(Error("Bridge is closed"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.proc.kill("SIGKILL");
        reject(
          Error(`Timed out: ${request.slice(0, 100)}; ${this.diagnostics}`),
        );
      }, 12000);
      this.waiters.push({ resolve, reject, timer });
      this.proc.stdin.write(
        typeof request === "string"
          ? request + "\n"
          : Buffer.concat([request, Buffer.from("\n")]),
      );
    });
  }
  newGame(seed = 42) {
    return this.call("new_game", {
      name: "Lifecycle",
      seed,
      role: "valkyrie",
      race: "dwarf",
      gender: "female",
      align: "lawful",
    });
  }
  async close(crash = false) {
    if (this.dead) return;
    if (crash) this.proc.kill("SIGKILL");
    else this.proc.stdin.end('{"tool":"shutdown"}\n');
    let timer: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([
        this.exited,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            this.proc.kill("SIGKILL");
            reject(Error("Bridge did not shut down cleanly"));
          }, 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer!);
    }
  }
}
