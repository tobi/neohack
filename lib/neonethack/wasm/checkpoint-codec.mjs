import { compress, decompress, digest } from "./protocol-recording.mjs";
const magic = new TextEncoder().encode("NNHCP001");
const MAX = 256 * 1024 * 1024;
export function checkpointBuffers(value) {
  const result = [];
  function visit(v) {
    if (v instanceof Uint8Array) {
      result.push(v.buffer);
      return;
    }
    if (v && typeof v === "object")
      for (const child of Object.values(v)) visit(child);
  }
  visit(value);
  return [...new Set(result)];
}
export async function encodeCheckpoint(value) {
  const buffers = [];
  const metadata = new TextEncoder().encode(
    JSON.stringify(value, (_key, v) => {
      if (v instanceof Uint8Array) {
        buffers.push(v);
        return { $buffer: buffers.length - 1 };
      }
      return v;
    }),
  );
  const length =
    16 +
    metadata.length +
    buffers.length * 4 +
    buffers.reduce((n, b) => n + b.length, 0);
  if (
    length > MAX ||
    metadata.length > 2 * 1024 * 1024 ||
    buffers.length > 10000
  )
    throw Error("Checkpoint exceeds its size limit");
  const packet = new Uint8Array(length),
    view = new DataView(packet.buffer);
  packet.set(magic);
  view.setUint32(8, metadata.length, true);
  view.setUint32(12, buffers.length, true);
  packet.set(metadata, 16);
  let offset = 16 + metadata.length;
  for (const buffer of buffers) {
    view.setUint32(offset, buffer.length, true);
    offset += 4;
  }
  for (const buffer of buffers) {
    packet.set(buffer, offset);
    offset += buffer.length;
  }
  const bytes = await compress(packet);
  return { bytes, sha256: await digest(bytes) };
}
export async function decodeCheckpoint(bytes, sha256) {
  if (bytes.length > 4 * 1024 * 1024 || (await digest(bytes)) !== sha256)
    throw Error("Checkpoint checksum differs");
  const packet = await decompress(bytes, MAX);
  if (packet.length < 16 || magic.some((b, i) => packet[i] !== b))
    throw Error("Invalid checkpoint header");
  const view = new DataView(
      packet.buffer,
      packet.byteOffset,
      packet.byteLength,
    ),
    size = view.getUint32(8, true),
    count = view.getUint32(12, true);
  if (
    size > 2 * 1024 * 1024 ||
    count > 10000 ||
    16 + size + count * 4 > packet.length
  )
    throw Error("Invalid checkpoint table");
  let offset = 16 + size + count * 4;
  const buffers = [];
  for (let i = 0; i < count; i++) {
    const length = view.getUint32(16 + size + i * 4, true);
    if (offset + length > packet.length)
      throw Error("Incomplete checkpoint data");
    buffers.push(packet.subarray(offset, offset + length));
    offset += length;
  }
  if (offset !== packet.length) throw Error("Unexpected checkpoint data");
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      packet.subarray(16, 16 + size),
    ),
    (_key, value) => {
      if (
        value &&
        typeof value === "object" &&
        Object.hasOwn(value, "$buffer")
      ) {
        if (
          Object.keys(value).length !== 1 ||
          !Number.isSafeInteger(value.$buffer) ||
          !buffers[value.$buffer]
        )
          throw Error("Invalid checkpoint buffer reference");
        return buffers[value.$buffer];
      }
      return value;
    },
  );
}
