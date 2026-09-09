import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { digest, validateRecord } from "../../wasm/protocol-recording.mjs";
import {
  encodeCheckpoint,
  decodeCheckpoint,
} from "../../wasm/checkpoint-codec.mjs";
import { inputRecords, validateManifest } from "../../wasm/protocol-reader.mjs";
import { ProtocolUploader } from "../../wasm/protocol-uploader.mjs";

const id = "abcdefghijklmnop",
  buildId = "a".repeat(64);
const record = (index) => ({
  index,
  request: {
    version: 1,
    method: index ? "game.wait" : "session.create",
    params: index
      ? { sessionId: id, requestId: "r-" + index, expectedRevision: index - 1 }
      : { seed: 42 },
  },
  ...(index ? {} : { creation: { id, epoch: 1700000000 } }),
  digest: "b".repeat(64),
  integrity: [],
});
const body = (from, records) => ({
  format: "neonethack.inputs",
  version: 1,
  id,
  buildId,
  from,
  records,
  complete: false,
});
async function archive(records) {
  const bytes = gzipSync(JSON.stringify(body(0, records))),
    sha256 = await digest(bytes);
  const chunk = {
    from: 0,
    count: records.length,
    bytes: bytes.length,
    sha256,
    path: "chunks/" + sha256 + ".gz",
  };
  return {
    bytes,
    manifest: {
      format: "neonethack.inputs",
      version: 1,
      id,
      buildId,
      count: records.length,
      complete: false,
      chunks: [chunk],
    },
  };
}

test('packed playback files exceed upload batch counts and retain exact cursor selection',async t=>{
 const records=Array.from({length:1000},(_,i)=>record(i)),packed=await archive(records);
 t.mock.method(globalThis,'fetch',async()=>new Response(packed.bytes));
 const loaded=[];for await(const r of inputRecords(packed.manifest,'https://cdn.example/manifest.json',{from:731}))loaded.push(r);
 assert.deepEqual(loaded,records.slice(731));
 const invalid=structuredClone(packed.manifest);invalid.count=8193;invalid.chunks[0].count=8193;
 assert.throws(()=>validateManifest(invalid),/invalid range/);
});

test("static input format rejects broken ranges, cross-run inputs and integrity loss", async (t) => {
  const good = await archive([record(0), record(1)]);
  let bytes = good.bytes;
  t.mock.method(globalThis, "fetch", async () => new Response(bytes));
  const collect = async (manifest) => {
    const result = [];
    for await (const r of inputRecords(
      manifest,
      "https://cdn.example/replays/" + id + "/manifest.json",
    ))
      result.push(r);
    return result;
  };
  assert.deepEqual(await collect(good.manifest), [record(0), record(1)]);
  for (const mutate of [
    (m) => m.count++,
    (m) => m.chunks[0].from++,
    (m) => (m.chunks[0].path = "../elsewhere.gz"),
    (m) => (m.buildId = "current"),
  ]) {
    const m = structuredClone(good.manifest);
    mutate(m);
    assert.throws(() => validateManifest(m));
  }
  bytes = Buffer.from(good.bytes);
  bytes[bytes.length - 2] ^= 1;
  await assert.rejects(collect(good.manifest), /checksum/);
  for (const mutate of [
    (r) => delete r.integrity,
    (r) => (r.integrity = [{ rng: {} }]),
    (r) => (r.request.params.sessionId = "different-run-id"),
    (r) => (r.index = 2),
  ]) {
    const r = record(1);
    mutate(r);
    const bad = await archive([record(0), r]);
    bytes = bad.bytes;
    await assert.rejects(collect(bad.manifest));
  }
  const missing = record(0);
  delete missing.creation;
  assert.throws(() => validateRecord(missing, 0));
});

/** Many small chunks, as a live recording produces them. */
async function chunked(count, per) {
  const chunks = [], files = new Map();
  for (let from = 0; from < count; from += per) {
    const records = [];
    for (let i = from; i < Math.min(count, from + per); i++) records.push(record(i));
    const bytes = gzipSync(JSON.stringify(body(from, records))), sha256 = await digest(bytes);
    chunks.push({ from, count: records.length, bytes: bytes.length, sha256, path: "chunks/" + sha256 + ".gz" });
    files.set("chunks/" + sha256 + ".gz", bytes);
  }
  return { files, manifest: { format: "neonethack.inputs", version: 1, id, buildId, count, complete: false, chunks } };
}

test("chunks fetched ahead in parallel still yield inputs strictly in order; a corrupt or failed later chunk is rejected before use", async (t) => {
  const { files, manifest } = await chunked(30, 3);
  const base = "https://cdn.example/replays/" + id + "/manifest.json";
  const started = [], settled = [];
  let inFlightMax = 0, inFlight = 0, tamper = null;
  // Downloads complete in reverse order of starting, so any ordering must come
  // from the reader, not the network.
  t.mock.method(globalThis, "fetch", (url) => {
    const path = new URL(url).pathname.replace(/^.*\/replays\/[^/]+\//, "");
    started.push(path);
    inFlightMax = Math.max(inFlightMax, ++inFlight);
    const index = manifest.chunks.findIndex((c) => c.path === path);
    return new Promise((resolve) => setTimeout(() => {
      inFlight--;
      settled.push(path);
      let bytes = files.get(path);
      if (tamper?.index === index) {
        if (tamper.kind === "corrupt") { bytes = Buffer.from(bytes); bytes[bytes.length - 3] ^= 1; }
        if (tamper.kind === "fail") return resolve(new Response("gone", { status: 404 }));
      }
      resolve(new Response(bytes));
    }, 12 - 2 * (index % 6)));
  });
  const collect = async (options, onRecord = () => {}) => {
    const result = [];
    for await (const r of inputRecords(manifest, base, options)) { result.push(r.index); onRecord(r, result); }
    return result;
  };
  const ordered = await collect({ prefetch: 6 });
  assert.deepEqual(ordered, Array.from({ length: 30 }, (_, i) => i));
  assert.ok(inFlightMax > 1 && inFlightMax <= 6, "a bounded window of chunks is in flight: " + inFlightMax);
  assert.notDeepEqual(settled.slice(0, 6), started.slice(0, 6), "the network completed downloads out of order");
  assert.deepEqual(await collect({ prefetch: 1 }), ordered, "a window of one is the sequential reader");

  // The prefetched-but-not-yet-consumed chunk is checked when its turn comes:
  // every input before it is delivered, nothing from or after it is.
  for (const kind of ["corrupt", "fail"]) {
    tamper = { index: 4, kind };
    let seen = [];
    await assert.rejects(collect({ prefetch: 6 }, (_, result) => { seen = result; }), kind === "corrupt" ? /checksum/ : /.+/);
    assert.deepEqual(seen, Array.from({ length: 12 }, (_, i) => i), kind + ": inputs before the bad chunk were delivered in order, none after");
  }
  tamper = null;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(inFlight, 0, "abandoned prefetches finish quietly without unhandled rejections");
  assert.deepEqual(await collect({ prefetch: 4, from: 20 }), Array.from({ length: 10 }, (_, i) => 20 + i), "resuming skips chunks entirely before the cursor");
});

test("checkpoint binary codec checks lengths, hashes, buffer references and bounded decompression", async () => {
  const value = {
    version: 1,
    buildId,
    index: 32,
    core: { state: { memory: new Uint8Array([0, 1, 2, 255]) } },
    empty: new Uint8Array(0),
  };
  const encoded = await encodeCheckpoint(value);
  assert.deepEqual(
    await decodeCheckpoint(encoded.bytes, encoded.sha256),
    value,
  );
  await assert.rejects(
    decodeCheckpoint(encoded.bytes, "0".repeat(64)),
    /checksum/,
  );
  const encodeRaw = async (value) => {
    const bytes = gzipSync(value);
    return [bytes, await digest(bytes)];
  };
  await assert.rejects(
    decodeCheckpoint(...(await encodeRaw(Buffer.from("NNHCP001")))),
    /header/,
  );
  const raw = Buffer.alloc(20);
  raw.write("NNHCP001");
  raw.writeUInt32LE(200000, 8);
  raw.writeUInt32LE(1, 12);
  await assert.rejects(decodeCheckpoint(...(await encodeRaw(raw))), /table/);
  for (const metadata of [
    { x: { $buffer: 4 } },
    { x: { $buffer: 0, extra: 1 } },
  ]) {
    const json = Buffer.from(JSON.stringify(metadata)),
      packet = Buffer.alloc(16 + json.length);
    packet.write("NNHCP001");
    packet.writeUInt32LE(json.length, 8);
    json.copy(packet, 16);
    await assert.rejects(
      decodeCheckpoint(...(await encodeRaw(packet))),
      /buffer reference/,
    );
  }
});

function fixture(t, count = 1) {
  const records = Array.from({ length: count }, (_, i) => record(i)),
    header = { id, buildId, count, complete: false };
  let ack,
    reads = 0;
  const uploads = [];
  const store = {
    upload: async () => structuredClone(ack),
    acknowledge: async (_id, v) => {
      ack = structuredClone(v);
    },
    range: async (_id, from, limit) => {
      reads++;
      return structuredClone(records.slice(from, from + limit));
    },
  };
  const headers = new Map([[id, header]]);
  const uploader = new ProtocolUploader({
    store,
    headers,
    url: "https://example.test/api/runs/",
    token: "test",
  });
  t.after(() => uploader.close());
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    uploads.push(new Uint8Array(options.body));
    const batch = JSON.parse(
      (await import("node:zlib")).gunzipSync(options.body),
    );
    return Response.json({
      through: batch.from + batch.records.length,
      hash: await digest(options.body),
      manifest: "https://cdn.example/manifest.json",
    });
  });
  return {
    uploader,
    store,
    header,
    records,
    uploads,
    reads: () => reads,
    ack: () => ack,
  };
}

test("upload scheduling waits five seconds idle, or thirty seconds of ongoing activity", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const f = fixture(t);
  f.uploader.queue(id);
  assert.equal(f.reads(), 0);
  t.mock.timers.tick(4999);
  assert.equal(f.reads(), 0);
  t.mock.timers.tick(1);
  await f.uploader.flight;
  assert.equal(f.uploads.length, 1);
  f.records.push(record(1));
  f.header.count = 2;
  f.uploader.queue(id);
  for (let n = 0; n < 7; n++) {
    t.mock.timers.tick(4000);
    f.uploader.queue(id);
    assert.equal(f.uploads.length, 1);
  }
  t.mock.timers.tick(1999);
  assert.equal(f.uploads.length, 1);
  t.mock.timers.tick(1);
  await f.uploader.flight;
  assert.equal(f.uploads.length, 2);
});

test("lost acknowledgements and process reopening retry identical compressed bytes", async (t) => {
  const f = fixture(t, 3);
  let attempts = 0,
    first;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    if (++attempts === 1) {
      first = new Uint8Array(options.body);
      throw Error("offline after server commit");
    }
    assert.deepEqual(new Uint8Array(options.body), first);
    return Response.json({
      through: 3,
      hash: await digest(first),
      manifest: "https://cdn.example/manifest.json",
    });
  });
  f.uploader.queue(id);
  await f.uploader.flush();
  assert.equal(f.ack().count, 0);
  assert.ok(f.ack().pending);
  assert.equal(f.reads(), 1);
  f.uploader.close();
  const reopened = new ProtocolUploader({
    store: f.store,
    headers: new Map([[id, f.header]]),
    url: "https://example.test/api/runs/",
    token: "test",
  });
  t.after(() => reopened.close());
  reopened.queue(id);
  await reopened.flush();
  assert.equal(f.ack().count, 3);
  assert.equal(f.reads(), 1, "retries do not reread or reserialize the log");
  assert.equal(f.ack().pending, undefined);
});

test("background upload cannot acknowledge a different prefix or block local appends", async (t) => {
  const f = fixture(t);
  let release;
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Promise((r) => {
        release = r;
      }),
  );
  f.uploader.queue(id);
  const upload = f.uploader.flush();
  while (!release) await new Promise((r) => setImmediate(r));
  f.records.push(record(1));
  f.header.count = 2;
  f.uploader.queue(id);
  assert.equal(
    f.records.length,
    2,
    "local work continues while upload is outstanding",
  );
  release(Response.json({ through: 99, hash: "c".repeat(64) }));
  await upload;
  assert.equal(f.ack().count, 0);
  assert.ok(f.ack().pending);
});

test("large counted-action evidence is split into bounded chunks without dropping inputs", async (t) => {
  const f = fixture(t, 5);
  for (const r of f.records) r.integrity = [{ fixture: "x".repeat(400000) }];
  f.uploader.queue(id);
  await f.uploader.flush();
  assert.equal(f.ack().count, 5);
  assert.equal(f.uploads.length, 3);
  for (const bytes of f.uploads) {
    assert.ok(bytes.length <= 512 * 1024);
    assert.ok(
      (await import("node:zlib")).gunzipSync(bytes).length <= 1024 * 1024,
    );
  }
});

test("long valid playlists remain readable and oversized manifest bodies are bounded", async (t) => {
  const { inputManifest, replayDocument } =
    await import("../../wasm/protocol-reader.mjs");
  const chunks = Array.from({ length: 12000 }, (_, from) => ({
    from,
    count: 1,
    bytes: 100,
    sha256: "a".repeat(64),
    path: "chunks/" + "a".repeat(64) + ".gz",
  }));
  const manifest = {
    format: "neonethack.inputs",
    version: 1,
    id,
    buildId,
    count: chunks.length,
    complete: false,
    chunks,
  };
  const text = JSON.stringify(manifest);
  assert.ok(text.length > 2 * 1024 * 1024);
  t.mock.method(globalThis, "fetch", async () => new Response(text));
  assert.equal(
    (await inputManifest("https://cdn.example/manifest.json")).count,
    12000,
  );
  let sent = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (sent++ < 33) controller.enqueue(new Uint8Array(1024 * 1024));
      else controller.close();
    },
  });
  await assert.rejects(replayDocument(new Response(stream)), /size limit/);
});

test('registration failures and reopening retain the exact pending batch before any upload', async t => {
  const f=fixture(t,3);
  let attempts=0;
  f.uploader.register=async()=>{attempts++;throw Error('registration offline')};
  f.uploader.queue(id);await f.uploader.flush();
  const pending=structuredClone(f.ack().pending);
  assert.equal(f.uploads.length,0);assert.equal(f.ack().count,0);
  await f.uploader.flush();assert.equal(attempts,2);
  assert.deepEqual(f.ack().pending,pending);assert.equal(f.reads(),1);
  f.uploader.close();
  let release;const gate=new Promise(r=>release=r);
  const reopened=new ProtocolUploader({store:f.store,headers:new Map([[id,f.header]]),url:'https://example.test/api/runs/',token:'test',register:()=>gate});
  t.after(()=>reopened.close());reopened.queue(id);
  const flight=reopened.flush();await new Promise(r=>setImmediate(r));
  assert.equal(f.uploads.length,0);
  release();await flight;
  assert.deepEqual(f.uploads[0],pending.bytes);assert.equal(f.ack().count,3);
  assert.equal(f.reads(),1,'registration and restart never reread previous inputs');
});

test('closing during registration cancels it without upload or retry timer', async t => {
  t.mock.timers.enable({apis:['setTimeout','Date'],now:1000});
  const f=fixture(t);let registered=0,signal;
  f.uploader.register=(_id,s)=>{signal=s;registered++;return new Promise((_,reject)=>s.addEventListener('abort',()=>reject(Error('closed')),{once:true}))};
  f.uploader.queue(id);const flight=f.uploader.flush();
  while(!signal)await new Promise(r=>setImmediate(r));
  const pending=structuredClone(f.ack().pending);
  f.uploader.close();await flight;
  assert.ok(signal.aborted);t.mock.timers.tick(120000);
  assert.equal(registered,1);assert.equal(f.uploads.length,0);
  assert.equal(f.ack().count,0);assert.deepEqual(f.ack().pending,pending);
});
