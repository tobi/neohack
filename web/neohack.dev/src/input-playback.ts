import type { Snapshot } from "neonethack/types";
import { isSnapshot } from "../../../lib/neonethack/typescript/client";
import {
  inputRecords,
  validateManifest,
  checkpointBytes,
} from "../../../lib/neonethack/wasm/protocol-reader.mjs";

/** Reconstructs scenes locally using a bounded window of prefetched compressed
 * chunks and the current scene, without accumulating a second full run buffer. */
export class InputPlayback {
  private transport?: import("neonethack/wasm").WasmTransport;
  private records?: AsyncGenerator<any>;
  index = -1;
  private closed = false;
  private tail: Promise<unknown> = Promise.resolve();
  private last?: Snapshot;
  constructor(
    readonly manifest: any,
    private url: URL,
    private signal: AbortSignal,
  ) {
    validateManifest(manifest);
  }
  private async reset(checkpoint?: any) {
    await this.transport?.close().catch(() => {});
    const wasm: typeof import("neonethack/wasm") = await import(
      new URL("/runtime/typescript/wasm.js", import.meta.url).href
    );
    if (this.closed || this.signal.aborted) throw Error("Replay cancelled");
    const base = new URL(
      "/runtime/wasm/" + this.manifest.buildId + "/",
      import.meta.url,
    );
    const transport = await wasm.WasmTransport.create({
      storage: { kind: "memory" },
      runtimeUrl: base.href,
      workerUrl: new URL("core-worker.mjs", base),
      playbackArchive: { manifest: this.manifest, url: this.url.href },
    });
    if (this.closed || this.signal.aborted) {
      await transport.close();
      throw Error("Replay cancelled");
    }
    this.transport = transport;
    this.records = inputRecords(this.manifest, this.url, {
      signal: this.signal,
    });
    this.index = -1;
    if (checkpoint) {
      try {
        const restored = await this.transport.restoreCheckpointBytes(
          await checkpointBytes(checkpoint, this.url, this.signal),
        );
        if (!isSnapshot(restored.preview))
          throw Error("Checkpoint preview is missing");
        this.index = restored.index - 1;
        this.last = restored.preview;
        this.records = inputRecords(this.manifest, this.url, {
          signal: this.signal,
          from: restored.index,
        });
      } catch (error) {
        if (this.signal.aborted) throw error;
        await this.reset();
      }
    }
  }
  seek(index: number): Promise<Snapshot> {
    const result = this.tail.then(() => this.seekAt(index));
    this.tail = result.catch(() => {});
    return result;
  }
  private async seekAt(index: number): Promise<Snapshot> {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= this.manifest.count
    )
      throw Error("Input outside replay");
    const checkpoint = this.manifest.checkpoints
      ?.filter((c: any) => c.index <= index + 1)
      .at(-1);
    if (
      !this.transport ||
      index <= this.index ||
      (checkpoint && checkpoint.index > this.index + 64)
    )
      await this.reset(checkpoint);
    let result: any = this.last;
    while (this.index < index) {
      const batch = [];
      while (batch.length < 64 && this.index + batch.length < index) {
        const next = await this.records!.next();
        if (next.done) throw Error("Input archive ended early");
        batch.push(next.value);
      }
      if (this.closed || this.signal.aborted) throw Error("Replay cancelled");
      result = await this.transport!.playbackBatch(batch);
      this.index += batch.length;
    }
    if (!isSnapshot(result))
      throw Error(result?.error?.message ?? "Recorded input produced no scene");
    this.last = result;
    return result;
  }
  async close() {
    this.closed = true;
    await this.records?.return(undefined);
    await this.transport?.close();
  }
}
