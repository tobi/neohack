export const recordingFormat = "neonethack.inputs";
// Playback files are packed independently of the uploader's 128-record batches.
// A packed file also carries exact upload receipts. Leave room above the
// uploader's 1 MiB decoded / 512 KiB compressed cap for a largest valid input.
export const inputChunkLimits = Object.freeze({compressedBytes:1024*1024,decodedBytes:2*1024*1024,records:8192});
export const randomRunId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_");
};
export const digest = async (value) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        typeof value === "string" ? new TextEncoder().encode(value) : value,
      ),
    ),
  )
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
export async function compress(value) {
  return new Uint8Array(
    await new Response(
      new Blob([value]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );
}
export async function decompress(bytes, limit = 2 * 1024 * 1024) {
  const reader = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  const parts = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit)
        throw Error("Recording exceeds its decoded size limit");
      parts.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result;
}
export function validateRecord(record, index) {
  if (
    !record ||
    record.index !== index ||
    record.request?.version !== 1 ||
    typeof record.request?.method !== "string" ||
    !record.request.params ||
    Array.isArray(record.request.params) ||
    JSON.stringify(record.request).length > 4096 ||
    (record.digest !== undefined && !/^[a-f0-9]{64}$/.test(record.digest))
  )
    throw Error("Invalid protocol recording entry");
  if (record.digest !== undefined) validateIntegrity(record.integrity);
  if (index === 0 && record.request.method !== "session.create")
    throw Error("Missing recorded world identity");
  if (record.request.method === "session.create") {
    const c = record.creation;
    if (
      index !== 0 ||
      !c ||
      !/^[A-Za-z0-9_-]{16}$/.test(c.id) ||
      !Number.isSafeInteger(c.epoch) ||
      c.epoch < 0 ||
      c.epoch > 4102444799 ||
      !Number.isSafeInteger(record.request.params.seed)
    )
      throw Error("Invalid recorded world identity");
  } else if (record.creation) throw Error("Unexpected recorded world identity");
  return record;
}
export function validateIntegrity(records) {
  if (!Array.isArray(records) || records.length > 4096)
    throw Error("Invalid replay RNG boundaries");
  for (const r of records) {
    if (
      !Number.isSafeInteger(r?.inputCount) ||
      r.inputCount < 0 ||
      !Number.isSafeInteger(r.inputId) ||
      typeof r.kind !== "string" ||
      r.kind.length > 80 ||
      r.rng?.algorithm !== "isaac64-sha256-v1"
    )
      throw Error("Invalid replay RNG boundary");
    for (const name of ["core", "display"]) {
      const s = r.rng[name];
      if (
        !s ||
        typeof s.draws !== "string" ||
        typeof s.seeds !== "string" ||
        !/^(0|[1-9][0-9]{0,19})$/.test(s.draws) ||
        !/^(0|[1-9][0-9]{0,19})$/.test(s.seeds) ||
        !/^[a-f0-9]{64}$/.test(s.state)
      )
        throw Error("Invalid replay RNG fingerprint");
    }
  }
}
