import type { Transport } from './client.js';
import type { Request, Response } from './types.js';

export interface TraceIdentity {
  /** Public logical run ID, stable across player-process restarts. Never a vault URL. */
  runId: string;
  /** New ID each player-process start; this is not a new life. */
  processId: string;
  codeVersion: string;
  runtime: { backend: 'native' | 'wasm'; packageId: string; libraryVersion: string; runtimeProfile?: number };
}
export interface TraceOptions { maxChunkBytes?: number; maxTotalBytes?: number; maxRecords?: number }
function immutable<T>(value: T, ancestors = new WeakSet<object>()): T {
  if (value && typeof value === 'object') {
    if (ancestors.has(value)) throw Error('Cyclic trace input is invalid before submission.');
    ancestors.add(value);
    for (const item of Object.values(value)) immutable(item, ancestors);
    ancestors.delete(value);
    Object.freeze(value);
  }
  return value;
}
const privateKey = /^(?:url|.*url|.*uri|.*path|.*tokens?|.*secrets?|.*passwords?|.*credentials?|authorization|cookies?|vault|vaultKey|saveKey|replicaKey|apiKey)$/i;
function redact(value: unknown, changed: { count: number }): unknown {
  if (typeof value === 'string') {
    const clean = value.replace(/(?:https?:\/\/|file:\/\/)[^\s<>"']+|\bBearer\s+[^\s]+|\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/gi, '[REDACTED]');
    if (clean !== value) changed.count++;
    return clean;
  }
  if (Array.isArray(value)) return value.map(item => redact(item, changed));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (privateKey.test(key)) { changed.count++; return [key, '[REDACTED]']; }
    return [key, redact(item, changed)];
  }));
  return value;
}
async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new globalThis.Response(stream).arrayBuffer());
}

/** Opt-in bounded public evidence. Not an engine journal, save or replay input.
 * Compression/redaction failures stop recording; they never retry game input.
 * Export only after input settles. Review the export before sharing: arbitrary
 * player text can contain secrets that pattern redaction cannot recognize. */
export class PublicTrace {
  private readonly identity: TraceIdentity;
  private readonly maxChunk: number;
  private readonly maxTotal: number;
  private readonly maxRecords: number;
  private chunks: { name: string; bytes: Uint8Array; records: number; rawBytes: number }[] = [];
  private total = 0;
  private records = 0;
  private redactions = 0;
  private stopped: string | null = null;
  private busy = false;
  constructor(identity: TraceIdentity, options: TraceOptions = {}) {
    if (!identity.runId || !identity.processId || !identity.codeVersion || !identity.runtime.packageId)
      throw Error('Actual package identity and distinct run/process/code identities are required.');
    const changed = { count: 0 };
    this.identity = immutable(redact(structuredClone(identity), changed) as TraceIdentity);
    this.redactions = changed.count;
    this.maxChunk = options.maxChunkBytes ?? 1024 * 1024;
    this.maxTotal = options.maxTotalBytes ?? 16 * 1024 * 1024;
    this.maxRecords = options.maxRecords ?? 10000;
    for (const n of [this.maxChunk, this.maxTotal, this.maxRecords])
      if (!Number.isSafeInteger(n) || n <= 0) throw Error('Trace limits must be positive safe integers.');
  }
  get status() { return { records: this.records, compressedBytes: this.total, stopped: this.stopped }; }
  wrap(transport: Transport): Transport {
    return {
      send: async request => {
        if (this.busy) throw Error('Trace owner already has an invocation in flight.');
        // Invalid JS input is rejected before submission, not an uncertain
        // engine execution. It must not poison ownership or create a trace row.
        const exact = immutable(structuredClone(request));
        this.busy = true;
        let response: Response | undefined;
        try {
          response = await transport.send(exact);
          await this.record(exact, response);
          return response;
        } catch (error) {
          if (!response) await this.record(exact, undefined);
          throw error;
        } finally { this.busy = false; }
      },
      close: () => transport.close(),
    };
  }
  private async record(request: Request, response?: Response) {
    if (this.stopped) return;
    try {
      if (this.records >= this.maxRecords) { this.stopped = 'record limit'; return; }
      const frame = response && 'observation' in response ? response : undefined;
      const changed = { count: 0 };
      const entry = redact({
        sequence: this.records + 1, ...this.identity,
        sessionId: frame?.sessionId ?? ('sessionId' in request.params ? request.params.sessionId : null),
        request, response: response ?? null,
        result: response ? 'response' : 'transportUncertain',
        revision: frame?.revision ?? null, turn: frame?.observation.turn ?? null,
        intended: request.method, actual: frame?.outcome ?? null,
        ended: frame?.ended ?? null, end: frame?.end ?? null,
      }, changed);
      const raw = new TextEncoder().encode(JSON.stringify(entry) + '\n');
      if (raw.byteLength > this.maxChunk) { this.stopped = 'record exceeds chunk limit'; return; }
      const bytes = await gzip(raw);
      if (bytes.byteLength > this.maxChunk || this.total + bytes.byteLength > this.maxTotal) {
        this.stopped = 'compressed byte limit'; return;
      }
      this.records++; this.total += bytes.byteLength; this.redactions += changed.count;
      this.chunks.push({ name: `chunk-${this.records.toString().padStart(6, '0')}.jsonl.gz`, bytes, records: 1, rawBytes: raw.byteLength });
    } catch { this.stopped = 'recording failure'; }
  }
  export() {
    if (this.busy) throw Error('Wait for the invocation to settle before exporting.');
    return {
      manifest: immutable({ format: 'neonethack-public-trace-v1', identity: structuredClone(this.identity),
        replayable: false, scope: 'public request/response evidence; not an engine journal',
        complete: false, stopped: this.stopped, redactions: this.redactions,
        exactPublicPairs: this.redactions === 0, records: this.records, compressedBytes: this.total,
        chunks: this.chunks.map(({ name, bytes, records, rawBytes }) => ({ name, compressedBytes: bytes.byteLength, rawBytes, records })),
      }),
      chunks: this.chunks.map(({ name, bytes }) => ({ name, bytes: bytes.slice() })),
    };
  }
}
