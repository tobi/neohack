import {
  decompress,
  digest,
  recordingFormat,
  inputChunkLimits,
  validateRecord,
} from "./protocol-recording.mjs";
async function bounded(response, limit) {
  if (!response.ok)
    throw Error(
      response.status === 404
        ? "This run has not reached online backup yet."
        : "Run download failed",
    );
  const reader = response.body.getReader(),
    parts = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) throw Error("Run download exceeds its size limit");
      parts.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
export async function inputManifest(url, signal) {
  const manifest = await replayDocument(
    await fetch(url, { credentials: "omit", signal }),
  );
  validateManifest(manifest);
  return manifest;
}
// Enough for the maximum 100,000 input chunks and 10,000 checkpoint descriptors.
// The same bound applies to initial component loads and restored-run imports.
export async function replayDocument(response) {
  const bytes = await bounded(response, 32 * 1024 * 1024);
  const hash = response.url?.match(
    /\/manifest-([a-f0-9]{64})\.json(?:\?|$)/,
  )?.[1];
  if (hash && (await digest(bytes)) !== hash)
    throw Error("Input manifest checksum differs");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
export function validateManifest(m) {
  if (
    m?.format !== recordingFormat ||
    m.version !== 1 ||
    !/^[A-Za-z0-9_-]{16}$/.test(m.id ?? "") ||
    !/^[a-f0-9]{64}$/.test(m.buildId ?? "") ||
    !Array.isArray(m.chunks) ||
    m.chunks.length > 100000 ||
    !Number.isSafeInteger(m.count) ||
    m.count < 1 ||
    typeof m.complete !== "boolean"
  )
    throw Error("Invalid input manifest");
  let count = 0;
  for (const c of m.chunks) {
    if (
      c.from !== count ||
      !Number.isSafeInteger(c.count) ||
      c.count < 1 ||
      c.count > inputChunkLimits.records ||
      !Number.isSafeInteger(c.bytes) ||
      c.bytes < 1 ||
      c.bytes > inputChunkLimits.compressedBytes ||
      !/^[a-f0-9]{64}$/.test(c.sha256 ?? "") ||
      c.path !== "chunks/" + c.sha256 + ".gz"
    )
      throw Error("Input playlist has a missing or invalid range");
    count += c.count;
  }
  if (count !== m.count) throw Error("Input playlist length differs");
  let previous = 0;
  if (m.checkpoints !== undefined) {
    if (!Array.isArray(m.checkpoints) || m.checkpoints.length > 10000)
      throw Error("Invalid checkpoint index");
    for (const c of m.checkpoints) {
      if (
        !Number.isSafeInteger(c.index) ||
        c.index <= previous ||
        c.index > m.count ||
        !Number.isSafeInteger(c.bytes) ||
        c.bytes < 16 ||
        c.bytes > 4 * 1024 * 1024 ||
        !/^[a-f0-9]{64}$/.test(c.sha256 ?? "") ||
        c.path !== "checkpoints/" + c.sha256 + ".gz"
      )
        throw Error("Invalid checkpoint entry");
      previous = c.index;
    }
  }
}
export async function checkpointBytes(entry, url, signal) {
  const bytes = await bounded(
    await fetch(new URL(entry.path, url), { credentials: "omit", signal }),
    4 * 1024 * 1024,
  );
  if (bytes.length !== entry.bytes || (await digest(bytes)) !== entry.sha256)
    throw Error("Checkpoint checksum differs");
  return { bytes, sha256: entry.sha256, index: entry.index };
}
/** Immutable chunks are content-addressed, so a bounded window of them is
 * fetched ahead in parallel; records are still yielded strictly in order and
 * verified before use. `prefetch` is the number of chunks in flight. */
export async function* inputRecords(
  manifest,
  url,
  { signal, from = 0, prefetch = 6 } = {},
) {
  validateManifest(manifest);
  const wanted = manifest.chunks.filter((c) => c.from + c.count > from);
  const inFlight = [];
  const window = Math.max(1, Math.min(32, prefetch | 0));
  const load = (chunk) => {
    const bytes = fetch(new URL(chunk.path, url), { credentials: "omit", signal }).then(
      (r) => bounded(r, inputChunkLimits.compressedBytes),
    );
    // A failure is reported when its chunk is consumed in order, not as an
    // unhandled rejection from a chunk fetched ahead.
    bytes.catch(() => {});
    return bytes;
  };
  let next = 0;
  for (let i = 0; i < wanted.length; i++) {
    while (next < wanted.length && next < i + window)
      inFlight.push(load(wanted[next++]));
    const chunk = wanted[i];
    const bytes = await inFlight.shift();
    if (bytes.length !== chunk.bytes || (await digest(bytes)) !== chunk.sha256)
      throw Error("Input chunk checksum differs");
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await decompress(bytes, inputChunkLimits.decodedBytes),
      ),
    );
    if (
      value.format !== recordingFormat ||
      value.version !== 1 ||
      value.id !== manifest.id ||
      value.buildId !== manifest.buildId ||
      value.from !== chunk.from ||
      !Array.isArray(value.records) ||
      value.records.length !== chunk.count
    )
      throw Error("Input chunk identity differs");
    for (let i = 0; i < value.records.length; i++) {
      const record = validateRecord(value.records[i], chunk.from + i);
      if (
        !record.digest ||
        (record.index === 0 && record.creation.id !== manifest.id) ||
        (record.index > 0 && record.request.params.sessionId !== manifest.id)
      )
        throw Error("Input belongs to another run");
      if (record.index >= from) yield record;
    }
  }
}
