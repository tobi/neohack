import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Neonethack, type Transport } from "./client.js";
import type { Request, Response } from "./types.js";
export interface NativeOptions {
  /** Public bridge executable, defaults to `neonethack` on PATH. */
  executable?: string;
  enginePath: string;
  dataPath: string;
  sessionsPath: string;
  /** Whole operation timeout, including engine replay. Default 150 seconds. */
  timeoutMs?: number;
}
export class NativeTransport implements Transport {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly timeoutMs: number;
  private readonly exited: Promise<void>;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private buffer = "";
  private diagnostics = "";
  private failed: Error | null = null;
  private closing = false;
  private tail: Promise<unknown> = Promise.resolve();
  private waiter: { resolve: (r: Response) => void; reject: (e: Error) => void } | null = null;
  constructor(options: NativeOptions) {
    this.timeoutMs = options.timeoutMs ?? 150_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw Error("timeoutMs must be positive");
    this.process = spawn(options.executable ?? "neonethack", [options.enginePath, options.dataPath, options.sessionsPath], { stdio: "pipe" });
    this.process.stderr.on("data", (data: Buffer) => { this.diagnostics = (this.diagnostics + data.toString("utf8")).slice(-4096); });
    this.process.stdout.on("data", (data: Buffer) => {
      try {
        this.buffer += this.decoder.decode(data, { stream: true });
        if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) throw Error("Bridge response exceeded 8 MiB");
        let newline: number;
        while ((newline = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, newline);
          this.buffer = this.buffer.slice(newline + 1);
          const response: unknown = JSON.parse(line);
          if (!response || typeof response !== "object" || !("version" in response) || response.version !== 1) throw Error("Invalid bridge response version");
          if (!this.waiter) throw Error("Unsolicited bridge response");
          const waiter = this.waiter; this.waiter = null;
          waiter.resolve(response as Response);
        }
      } catch (e) { this.fail(e instanceof Error ? e : Error(String(e))); }
    });
    this.process.on("error", error => this.fail(error));
    this.process.stdin.on("error", error => this.fail(error));
    this.exited = new Promise(resolve => this.process.once("close", () => {
      if (!this.closing || this.waiter) this.fail(Error(`Bridge exited; operation may have executed. ${this.diagnostics}`));
      resolve();
    }));
  }
  private fail(error: Error) {
    this.failed ??= error;
    const waiter = this.waiter; this.waiter = null;
    waiter?.reject(this.failed);
    this.process.kill("SIGKILL");
  }
  send(request: Request): Promise<Response> {
    // Serialize and capture before queuing, preserving the original payload.
    const frame = JSON.stringify(request);
    if (Buffer.byteLength(frame) > 4096) return Promise.reject(Error("Request exceeds 4096 UTF-8 bytes"));
    if (this.closing) return Promise.reject(Error("Transport is closed"));
    const run = this.tail.then(() => new Promise<Response>((resolve, reject) => {
      if (this.failed) { reject(this.failed); return; }
      const timer = setTimeout(() => this.fail(Error("Bridge timed out; execution is uncertain. Reopen, resume, and retry the same request ID.")), this.timeoutMs);
      this.waiter = {
        resolve: result => { clearTimeout(timer); resolve(result); },
        reject: error => { clearTimeout(timer); reject(error); },
      };
      this.process.stdin.write(frame + "\n", error => { if (error) this.fail(error); });
    }));
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
  async close(): Promise<void> {
    if (this.closing) return this.exited;
    this.closing = true;
    await this.tail;
    this.process.stdin.end();
    const timer = setTimeout(() => this.fail(Error("Bridge retirement timed out")), 10_000);
    try { await this.exited; } finally { clearTimeout(timer); }
  }
}
export function createNative(options: NativeOptions): Neonethack { return new Neonethack(new NativeTransport(options)); }
