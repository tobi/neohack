import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { readReplayBytes, writeReplayBytes } from "./public-replay-store.ts";
import {
  validateRecord,
  inputChunkLimits,
} from "../.generated/protocol-recording.mjs";

export const MAX_CHUNK_BYTES = inputChunkLimits.compressedBytes;
export const MAX_CHUNK_DECODED = inputChunkLimits.decodedBytes;
export const MAX_CHUNK_RECORDS = inputChunkLimits.records;
const sha = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
export type InputChunk = {
  path: string;
  sha256: string;
  bytes: number;
  from: number;
  count: number;
};
type Upload = { from: number; count: number; sha256: string };
type Contents = { records: any[]; uploads: Upload[] };
type Packed = { chunk: InputChunk; contents: Contents; bytes: Uint8Array };

function packed(
  id: string,
  buildId: string,
  contents: Contents,
): Packed | null {
  const { records, uploads } = contents,
    from = records[0].index;
  if (records.length > MAX_CHUNK_RECORDS) return null;
  const raw = Buffer.from(
    JSON.stringify({
      format: "neonethack.inputs",
      version: 1,
      id,
      buildId,
      from,
      records,
      uploads,
    }),
  );
  if (raw.length > MAX_CHUNK_DECODED) return null;
  const bytes = gzipSync(raw);
  if (bytes.length > MAX_CHUNK_BYTES) return null;
  const hash = sha(bytes);
  return {
    contents,
    bytes,
    chunk: {
      path: "chunks/" + hash + ".gz",
      sha256: hash,
      bytes: bytes.length,
      from,
      count: records.length,
    },
  };
}
export async function readInputChunk(
  id: string,
  buildId: string,
  chunk: InputChunk,
): Promise<Contents> {
  const bytes = await readReplayBytes("replays/" + id + "/" + chunk.path);
  if (
    chunk.path !== "chunks/" + chunk.sha256 + ".gz" ||
    bytes.length !== chunk.bytes ||
    sha(bytes) !== chunk.sha256
  )
    throw Error("Stored input checksum differs");
  const body = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      gunzipSync(bytes, { maxOutputLength: MAX_CHUNK_DECODED }),
    ),
  );
  if (
    body.format !== "neonethack.inputs" ||
    body.version !== 1 ||
    body.id !== id ||
    body.buildId !== buildId ||
    body.from !== chunk.from ||
    !Array.isArray(body.records) ||
    body.records.length !== chunk.count ||
    chunk.count < 1 ||
    chunk.count > MAX_CHUNK_RECORDS
  )
    throw Error("Stored input range differs");
  body.records.forEach((r: any, i: number) => {
    validateRecord(r, chunk.from + i);
    if (
      !r.digest ||
      (r.index === 0
        ? r.creation?.id !== id
        : r.request.params.sessionId !== id)
    )
      throw Error("Stored input identity differs");
  });
  // Original uploads require `complete`; packed envelopes omit it. Original
  // client extension fields are not writer-authored receipts. Their one exact
  // receipt is always the stored upload's hash, including after repacking.
  const uploads: Upload[] = typeof body.complete === "boolean"
    ? [{ from: chunk.from, count: chunk.count, sha256: chunk.sha256 }]
    : body.uploads;
  if (!Array.isArray(uploads) || uploads.length > chunk.count)
    throw Error("Invalid stored upload receipts");
  let previous = chunk.from - 1;
  for (const receipt of uploads) {
    if (
      !Number.isSafeInteger(receipt.from) ||
      receipt.from <= previous ||
      receipt.from < chunk.from ||
      receipt.from >= chunk.from + chunk.count ||
      !Number.isSafeInteger(receipt.count) ||
      receipt.count < 1 ||
      receipt.count > 128 ||
      !/^[a-f0-9]{64}$/.test(receipt.sha256)
    )
      throw Error("Invalid stored upload receipt");
    previous = receipt.from;
  }
  return { records: body.records, uploads };
}
export async function acceptedUpload(
  id: string,
  buildId: string,
  chunks: InputChunk[],
  from: number,
  count: number,
  hash: string,
) {
  const chunk = chunks.find((c) => c.from <= from && from < c.from + c.count);
  if (!chunk) return false;
  const contents = await readInputChunk(id, buildId, chunk),
    receipt = contents.uploads.find((r) => r.from === from);
  return receipt?.count === count && receipt.sha256 === hash;
}
function slices(id: string, buildId: string, contents: Contents): Packed[] {
  const result = packed(id, buildId, contents);
  if (result) return [result];
  if (contents.records.length === 1)
    throw Error("An input exceeds the packed chunk limit");
  const middle = Math.ceil(contents.records.length / 2),
    index = contents.records[middle].index;
  return [
    ...slices(id, buildId, {
      records: contents.records.slice(0, middle),
      uploads: contents.uploads.filter((r) => r.from < index),
    }),
    ...slices(id, buildId, {
      records: contents.records.slice(middle),
      uploads: contents.uploads.filter((r) => r.from >= index),
    }),
  ];
}
async function publish(id: string, value: Packed) {
  await writeReplayBytes("replays/" + id + "/" + value.chunk.path, value.bytes);
  return value.chunk;
}
/** Size-tiered packing bounds both live fetch count and write amplification.
 * Merge similarly sized suffix chunks up to the byte limit. Never rewrite the
 * whole growing run every five seconds. The creation record stays small/stable
 * so a viewer can show its first scene without downloading the next chunk. */
export async function appendInputChunks(
  id: string,
  buildId: string,
  chunks: InputChunk[],
  records: any[],
  hash: string,
): Promise<InputChunk[]> {
  if (
    records[0].index !==
    (chunks.length ? chunks.at(-1)!.from + chunks.at(-1)!.count : 0)
  )
    throw Error("Input append range differs");
  const stack = chunks.slice(),
    receipt = { from: records[0].index, count: records.length, sha256: hash };
  let remaining = records,
    uploads = [receipt];
  if (receipt.from === 0) {
    stack.push(
      await publish(
        id,
        slices(id, buildId, { records: records.slice(0, 1), uploads })[0],
      ),
    );
    remaining = records.slice(1);
    uploads = [];
  }
  for (let value of remaining.length
    ? slices(id, buildId, { records: remaining, uploads })
    : []) {
    while (stack.length && stack.at(-1)!.from > 0) {
      const last = stack.at(-1)!;
      if (last.bytes > value.chunk.bytes * 2) break;
      const contents = await readInputChunk(id, buildId, last);
      const merged = packed(id, buildId, {
        records: [...contents.records, ...value.contents.records],
        uploads: [...contents.uploads, ...value.contents.uploads],
      });
      if (!merged) break;
      stack.pop();
      value = merged;
    }
    stack.push(await publish(id, value));
  }
  return stack;
}
/** Seal a concluded run (or explicitly repack an existing one). Downloads are
 * bounded and ordered; old objects/manifests remain valid for their exact prefix. */
export async function compactInputChunks(
  id: string,
  buildId: string,
  chunks: InputChunk[],
  suffix = chunks.length,
): Promise<InputChunk[]> {
  let count = 0;
  for (const c of chunks) {
    if (c.from !== count || !Number.isSafeInteger(c.count) || c.count < 1)
      throw Error("Stored input ranges differ");
    count += c.count;
  }
  if (chunks.length < 3) return chunks;
  if (suffix >= chunks.length) await readInputChunk(id, buildId, chunks[0]);
  const start = Math.max(1, chunks.length - suffix),
    result: InputChunk[] = chunks.slice(0, start),
    pending: Promise<Contents>[] = [],
    window = 6;
  let next = start,
    tail: Packed | undefined;
  for (let i = start; i < chunks.length; i++) {
    while (next < chunks.length && next < i + window) {
      const work = readInputChunk(id, buildId, chunks[next++]);
      work.catch(() => {});
      pending.push(work);
    }
    const contents = await pending.shift()!;
    const merged =
      tail &&
      packed(id, buildId, {
        records: [...tail.contents.records, ...contents.records],
        uploads: [...tail.contents.uploads, ...contents.uploads],
      });
    if (merged) {
      tail = merged;
      continue;
    }
    if (tail) result.push(await publish(id, tail));
    const groups = slices(id, buildId, contents);
    for (const group of groups.slice(0, -1))
      result.push(await publish(id, group));
    tail = groups.at(-1)!;
  }
  if (tail) result.push(await publish(id, tail));
  return result;
}
