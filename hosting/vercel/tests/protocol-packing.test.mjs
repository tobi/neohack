import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { storageContext } from "../src/storage.ts";
import { publicReplayContext } from "../src/public-replay-store.ts";
import {
  protocolReplay,
  compactProtocolReplay,
  publishManifest,
} from "../src/protocol-replays.ts";
import { MAX_CHUNK_BYTES, MAX_CHUNK_DECODED } from "../src/protocol-chunks.ts";
import {
  inputRecords,
  validateManifest,
} from "../../../lib/neonethack/wasm/protocol-reader.mjs";
import { MemoryStorage } from "./server.mjs";
const id = "packingfixture01",
  buildId = "a".repeat(64),
  hash = (b) => createHash("sha256").update(b).digest("hex");
const record = (i) => ({
  index: i,
  request: {
    version: 1,
    method: i ? "game.wait" : "session.create",
    params: i
      ? { sessionId: id, requestId: "r-" + i, expectedRevision: i - 1 }
      : { seed: 9 },
  },
  ...(i ? {} : { creation: { id, epoch: 1700000000 } }),
  digest: hash("response-" + i),
  integrity: [],
});
const body = (from, records, complete = false) => ({
  format: "neonethack.inputs",
  version: 1,
  id,
  buildId,
  from,
  records,
  complete,
});
async function fixture() {
  const store = new MemoryStorage(),
    cdn = new MemoryStorage(),
    token = randomUUID(),
    head = "input-runs/" + id + ".json";
  await store.write("vaults/" + token + "/adventures.json", {
    values: [{ id, buildId, role: "valkyrie" }],
  });
  const scope = (fn) =>
    storageContext.run(store, () => publicReplayContext.run(cdn, fn));
  const send = (bytes) =>
    scope(() =>
      protocolReplay(
        new Request("https://neohack.dev/api/runs/" + id + "/inputs", {
          method: "PUT",
          headers: {
            authorization: "Bearer " + token,
            "x-content-sha256": hash(bytes),
          },
          body: bytes,
        }),
        id,
      ),
    );
  const upload = (records, complete = false) => {
    const bytes = gzipSync(
      JSON.stringify(body(records[0].index, records, complete)),
    );
    return { bytes, result: () => send(bytes) };
  };
  const latest = async () =>
    structuredClone((await cdn.read("replays/" + id + "/manifest.json")).value);
  async function decoded(manifest) {
    validateManifest(manifest);
    const records = [];
    for (const c of manifest.chunks) {
      const bytes = (await cdn.read("replays/" + id + "/" + c.path)).value;
      assert.equal(hash(bytes), c.sha256);
      assert.ok(bytes.length <= MAX_CHUNK_BYTES);
      const raw = gunzipSync(bytes);
      assert.ok(raw.length <= MAX_CHUNK_DECODED);
      records.push(...JSON.parse(raw).records);
    }
    return records;
  }
  return { store, cdn, token, head, scope, send, upload, latest, decoded };
}
test(
  "988 small uploads produce a handful of packed static chunks, retaining every input and original retry hash",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(),
      records = Array.from({ length: 4940 }, (_, i) => record(i));
    let early,
      earlyManifest,
      totalUploaded = 0,
      totalWritten = 0,
      maxLiveChunks = 0;
    const write = f.cdn.write.bind(f.cdn);
    f.cdn.write = async (path, value, etag) => {
      if (value instanceof Uint8Array && !f.cdn.docs.has(path))
        totalWritten += value.length;
      return write(path, value, etag);
    };
    for (let i = 0; i < 988; i++) {
      const upload = f.upload(records.slice(i * 5, i * 5 + 5), i === 987);
      totalUploaded += upload.bytes.length;
      const response = await upload.result();
      assert.equal(response.status, 200);
      const ack = await response.json();
      assert.equal(ack.hash, hash(upload.bytes));
      assert.equal(ack.through, (i + 1) * 5);
      const manifest = await f.latest();
      maxLiveChunks = Math.max(maxLiveChunks, manifest.chunks.length);
      if (i === 7) {
        early = { ...upload, ack };
        earlyManifest = manifest;
      }
    }
    const manifest = await f.latest();
    assert.ok(manifest.chunks.length <= 5, JSON.stringify(manifest.chunks));
    assert.ok(maxLiveChunks <= 16, "active playback also stays bounded");
    assert.ok(
      totalWritten < totalUploaded * 20,
      "packing must not rewrite an ever-growing megabyte for every tiny upload",
    );
    assert.deepEqual(await f.decoded(manifest), records);
    assert.deepEqual(
      await f.decoded(earlyManifest),
      records.slice(0, 40),
      "previously shared prefixes remain readable",
    );
    const retry = await early.result();
    assert.equal(retry.status, 200);
    const ack = await retry.json();
    assert.equal(ack.hash, early.ack.hash);
    assert.equal(ack.through, early.ack.through);
    const changed = structuredClone(records.slice(35, 40));
    changed[0].request.params.extra = "changed";
    assert.equal((await f.upload(changed).result()).status, 409);
    // Consume actual packed files through the shared static reader, including a
    // cursor in the middle of a large chunk. Only this test's fetch is substituted.
    const requests = [];
    t.mock.method(globalThis, "fetch", async (url) => {
      requests.push(String(url));
      const key = new URL(url).pathname.slice(1),
        doc = await f.cdn.read(key);
      return new Response(doc?.value, { status: doc ? 200 : 404 });
    });
    const loaded = [];
    for await (const r of inputRecords(
      manifest,
      "https://cdn.example/replays/" + id + "/manifest.json",
      { from: 1200 },
    ))
      loaded.push(r);
    assert.deepEqual(loaded, records.slice(1200));
    assert.ok(requests.length <= 5);
    t.diagnostic(
      JSON.stringify({
        uploads: 988,
        inputs: records.length,
        playbackChunks: manifest.chunks.length,
        maxLiveChunks,
        uploadedBytes: totalUploaded,
        writtenBytes: totalWritten,
      }),
    );
  },
);
test("packing spills at compressed and decoded size bounds without losing receipts across file boundaries", async () => {
  const f = await fixture(),
    records = Array.from({ length: 1400 }, (_, i) => ({
      ...record(i),
      request: {
        ...record(i).request,
        params: {
          ...record(i).request.params,
          padding: randomBytes(2000).toString("base64"),
        },
      },
    }));
  const uploads = [];
  for (let i = 0; i < records.length; i += 128) {
    const u = f.upload(records.slice(i, i + 128), i + 128 >= records.length);
    uploads.push(u);
    assert.equal((await u.result()).status, 200);
  }
  const manifest = await f.latest();
  assert.ok(manifest.chunks.length >= 4);
  assert.ok(manifest.chunks.some((c) => c.count > 128));
  assert.deepEqual(await f.decoded(manifest), records);
  for (const u of uploads) {
    const response = await u.result();
    assert.equal(response.status, 200);
    assert.equal((await response.json()).hash, hash(u.bytes));
  }
});
test("a lost packed-publication acknowledgement retries exactly after a later upload commits", async () => {
  const f = await fixture();
  assert.equal((await f.upload([record(0)]).result()).status, 200);
  const write = f.cdn.write.bind(f.cdn);
  let fail = true;
  f.cdn.write = async (path, ...args) => {
    if (fail && path.endsWith("/manifest.json"))
      throw Error("lost publication");
    return write(path, ...args);
  };
  const pending = f.upload([record(1), record(2)]);
  await assert.rejects(pending.result(), /lost publication/);
  assert.equal((await f.store.read(f.head)).value.count, 3);
  fail = false;
  assert.equal((await f.upload([record(3)]).result()).status, 200);
  const retry = await pending.result();
  assert.equal(retry.status, 200);
  const ack = await retry.json();
  assert.equal(ack.hash, hash(pending.bytes));
  assert.equal(ack.through, 3);
  assert.deepEqual(await f.decoded(await f.latest()), [0, 1, 2, 3].map(record));
});
test("a concurrent different append loses CAS and cannot retarget the accepted upload hash", async () => {
  const f = await fixture();
  assert.equal((await f.upload([record(0)]).result()).status, 200);
  let enter, release;
  const entered = new Promise((r) => (enter = r)),
    gate = new Promise((r) => (release = r)),
    write = f.store.write.bind(f.store);
  let hold = true;
  f.store.write = async (path, value, etag) => {
    if (path === f.head && hold) {
      hold = false;
      enter();
      await gate;
    }
    return write(path, value, etag);
  };
  const a = f.upload([record(1)]),
    other = { ...record(1), digest: hash("different receipt") },
    b = f.upload([other]);
  const first = a.result();
  await entered;
  try {
    assert.equal((await b.result()).status, 200);
  } finally {
    release();
  }
  assert.equal((await first).status, 409);
  assert.deepEqual(await f.decoded(await f.latest()), [record(0), other]);
  assert.equal((await a.result()).status, 409);
  assert.equal((await b.result()).status, 200);
});
test("corrupt prior chunks fail closed before a packed head advances", async () => {
  const f = await fixture();
  for (let i = 0; i < 2; i++)
    assert.equal((await f.upload([record(i)]).result()).status, 200);
  const before = await f.store.read(f.head),
    manifest = await f.latest(),
    path = "replays/" + id + "/" + manifest.chunks.at(-1).path;
  const old = await f.cdn.read(path);
  await f.cdn.write(path, new Uint8Array([1, 2, 3]), old.etag);
  await assert.rejects(f.upload([record(2)]).result(), /checksum/);
  assert.deepEqual(await f.store.read(f.head), before);
  assert.deepEqual(await f.latest(), manifest);
});
test("failed merged-object publication leaves the accepted head unchanged and retry commits once", async () => {
  const f = await fixture();
  for (let i = 0; i < 2; i++)
    assert.equal((await f.upload([record(i)]).result()).status, 200);
  const before = await f.store.read(f.head),
    manifest = await f.latest();
  const write = f.cdn.write.bind(f.cdn);
  let fail = true;
  f.cdn.write = async (path, value, etag) => {
    if (fail && value instanceof Uint8Array)
      throw Error("packed object unavailable");
    return write(path, value, etag);
  };
  const pending = f.upload([record(2)]);
  await assert.rejects(pending.result(), /packed object unavailable/);
  assert.deepEqual(await f.store.read(f.head), before);
  assert.deepEqual(await f.latest(), manifest);
  fail = false;
  assert.equal((await pending.result()).status, 200);
  assert.equal((await pending.result()).status, 200);
  assert.deepEqual(await f.decoded(await f.latest()), [0, 1, 2].map(record));
});
test("repacking cannot roll back a concurrently accepted input or checkpoint", async () => {
  const f = await fixture();
  for (let i = 0; i < 4; i++)
    assert.equal((await f.upload([record(i)]).result()).status, 200);
  let enter, release;
  const entered = new Promise((r) => (enter = r)),
    gate = new Promise((r) => (release = r));
  const write = f.store.write.bind(f.store);
  let hold = true;
  f.store.write = async (path, value, etag) => {
    if (path === f.head && hold) {
      hold = false;
      enter();
      await gate;
    }
    return write(path, value, etag);
  };
  const compact = f.scope(() => compactProtocolReplay(id));
  await entered;
  const checkpoint = {
    index: 4,
    path: "checkpoints/" + hash("cp") + ".gz",
    sha256: hash("cp"),
    bytes: 20,
  };
  try {
    assert.equal((await f.upload([record(4)]).result()).status, 200);
    const current = await f.store.read(f.head);
    current.value.checkpoints = [checkpoint];
    current.value.generation++;
    await f.store.write(f.head, current.value, current.etag);
  } finally {
    release();
  }
  await compact;
  const manifest = await f.latest();
  assert.deepEqual(await f.decoded(manifest), [0, 1, 2, 3, 4].map(record));
  assert.deepEqual(manifest.checkpoints, [checkpoint]);
  assert.equal((await f.store.read(f.head)).value.packedThrough, 5);
});
test("invalid UTF-8 cannot acquire different text while being packed", async () => {
  const f = await fixture();
  const raw = Buffer.from(
    JSON.stringify(body(0, [{ ...record(0), note: "sentinel" }])),
  );
  raw[raw.indexOf("sentinel")] = 255;
  assert.equal((await f.send(gzipSync(raw))).status, 400);
  assert.equal(await f.store.read(f.head), null);
});
test("a maximum decoded upload still fits with its exact retry receipt", async () => {
  const f = await fixture();
  assert.equal((await f.upload([record(0)]).result()).status, 200);
  const input = {...record(1), extension: ''};
  const empty = JSON.stringify(body(1, [input]));
  input.extension = 'x'.repeat(1024 * 1024 - Buffer.byteLength(empty));
  const raw = JSON.stringify(body(1, [input]));
  assert.equal(Buffer.byteLength(raw), 1024 * 1024);
  const upload = f.upload([input]);
  assert.equal((await upload.result()).status, 200);
  assert.equal((await upload.result()).status, 200);
  assert.deepEqual(await f.decoded(await f.latest()), [record(0), input]);
  assert.equal((await f.send(gzipSync(raw + ' '))).status, 400, 'upload bound itself has not expanded');
});
test("existing fragmented archives compact once, retain pins/checkpoints/receipt identity and old immutable links", async () => {
  const f = await fixture(),
    records = Array.from({ length: 400 }, (_, i) => record(i)),
    chunks = [];
  let originalUpload;
  for (const r of records) {
    // Older writers stored the client's whole upload envelope. A client-supplied
    // extension must not be mistaken for the new writer's authoritative receipts.
    const envelope = body(r.index, [r]);
    if(r.index===277) envelope.uploads=[{from:277,count:1,sha256:hash('untrusted extension')}];
    const bytes = gzipSync(JSON.stringify(envelope)),
      h = hash(bytes),
      chunk = {
        from: r.index,
        count: 1,
        sha256: h,
        bytes: bytes.length,
        path: "chunks/" + h + ".gz",
      };
    chunks.push(chunk);
    if(r.index===277)originalUpload=bytes;
    await f.cdn.write("replays/" + id + "/" + chunk.path, bytes);
  }
  const doc = {
    owner: hash(f.token),
    buildId,
    count: 400,
    generation: 400,
    chunks,
    complete: true,
    role: "valkyrie",
    seed: 9,
    checkpoints: [
      {
        index: 200,
        path: "checkpoints/" + hash("cp") + ".gz",
        sha256: hash("cp"),
        bytes: 20,
      },
    ],
    accountId: "private fixture owner",
    summary: { turn: 1 },
  };
  await f.store.write(f.head, doc);
  const oldPath = await f.scope(() => publishManifest(id)),
    oldManifest = await f.latest();
  await f.scope(() => compactProtocolReplay(id));
  const latest = await f.latest();
  assert.equal(latest.chunks.length, 2);
  assert.deepEqual(await f.decoded(latest), records);
  assert.deepEqual(await f.decoded(oldManifest), records);
  assert.deepEqual((await f.cdn.read(oldPath)).value, oldManifest);
  const after = (await f.store.read(f.head)).value;
  for (const key of [
    "owner",
    "buildId",
    "count",
    "complete",
    "role",
    "seed",
    "checkpoints",
    "accountId",
    "summary",
  ])
    assert.deepEqual(after[key], doc[key]);
  assert.equal((await f.send(originalUpload)).status, 200);
  const stable = await f.store.read(f.head);
  await f.scope(() => compactProtocolReplay(id));
  assert.deepEqual(
    await f.store.read(f.head),
    stable,
    "repacking an already sealed archive is a no-op",
  );
});
