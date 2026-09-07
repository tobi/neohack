import { Neonethack, type Transport } from "./client.js";
import type { Request, Response } from "./types.js";
import { worker, type WorkerPort } from "../wasm/worker-port.mjs";

export type WasmStorage =
  | { kind: "memory" }
  | { kind: "indexeddb"; name: string; replicaUrl?: string };
export interface WasmOptions {
  /** Defaults to volatile memory. IndexedDB also requires browser Web Locks. */
  storage?: WasmStorage;
  /** Relocate the entire dist/wasm directory together, not individual binaries. */
  workerUrl?: URL;
  timeoutMs?: number;
  onDiagnostic?: (message: string) => void;
  /** Remote replication is asynchronous; local durability remains awaited. */
  onReplicaStatus?: (status: { state: "queued" | "pending" | "saved" | "retrying" | "error"; message: string }) => void;
}
/** The worker boundary is private. All gameplay uses the same C ABI as native. */
export class WasmTransport implements Transport {
  private readonly worker: WorkerPort;
  private readonly timeoutMs: number;
  private failed: Error | null = null;
  private closing = false;
  private sequence = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private identity = "";
  get buildId(): string { return this.identity; }
  private constructor(options: WasmOptions) {
    this.timeoutMs = options.timeoutMs ?? 150_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw Error("timeoutMs must be positive");
    this.worker = worker(options.workerUrl ?? new URL("../wasm/core-worker.mjs", import.meta.url), message => {
      if (message.type === "replica") { options.onReplicaStatus?.({ state: message.state, message: message.message }); return; }
      if (message.type === "diagnostic") { options.onDiagnostic?.(message.text); return; }
      if (message.type === "fatal") { this.fail(Error(message.message)); return; }
      const pending = this.pending.get(message.id);
      if (message.type !== "result" || !pending) { this.fail(Error("Unexpected WASM worker response")); return; }
      this.pending.delete(message.id); pending.resolve(message.result);
    }, error => this.fail(error));
  }
  static async create(options: WasmOptions = {}): Promise<WasmTransport> {
    const transport = new WasmTransport(options);
    try {
      const initialized = await transport.exchange("init", { options: { storage: options.storage } });
      transport.identity = initialized.buildId;
      return transport;
    } catch (error) {
      transport.fail(error instanceof Error ? error : Error(String(error)));
      throw error;
    }
  }
  private fail(error: Error) {
    this.failed ??= error;
    for (const pending of this.pending.values()) pending.reject(this.failed);
    this.pending.clear();
    void this.worker.stop();
  }
  private exchange(type: string, payload: Record<string, unknown>): Promise<any> {
    if (this.failed) return Promise.reject(this.failed);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(Error("WASM worker timed out; execution is uncertain. Resume with the same package and retry the original request ID.")), this.timeoutMs);
      this.pending.set(id, {
        resolve: result => { clearTimeout(timer); resolve(result); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      try { this.worker.post({ id, type, ...payload }); }
      catch (error) { this.fail(error instanceof Error ? error : Error(String(error))); }
    });
  }
  send(request: Request): Promise<Response> {
    if (this.closing) return Promise.reject(Error("Transport is closed"));
    const copy = structuredClone(request);
    const run = this.tail.then(() => this.exchange("request", { request: copy }));
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await this.tail;
    try { if (!this.failed) await this.exchange("close", {}); }
    finally { await this.worker.stop(); }
  }
}
export async function createWasm(options: WasmOptions = {}): Promise<Neonethack> {
  return new Neonethack(await WasmTransport.create(options));
}
