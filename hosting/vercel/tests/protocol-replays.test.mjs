import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash, randomUUID } from "node:crypto";
import { storageContext } from "../src/storage.ts";
import { publicReplayContext } from "../src/public-replay-store.ts";
import { protocolReplay, protocolCheckpoint } from "../src/protocol-replays.ts";
import { MemoryStorage } from "./server.mjs";
const hash = (b) => createHash("sha256").update(b).digest("hex");
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

test("compressed input publication is append-only, exactly acknowledged and entirely static to read", async () => {
  const privateStore = new MemoryStorage(),
    cdn = new MemoryStorage(),
    vault = randomUUID();
  await privateStore.write("vaults/" + vault + "/adventures.json", {
    values: [
      { id, buildId, name: "Replay", role: "valkyrie", turn: 1, ended: false },
    ],
  });
  const put = (from, records, extra = {}, token = vault) => {
    const bytes = gzipSync(
      JSON.stringify({
        format: "neonethack.inputs",
        version: 1,
        id,
        buildId,
        from,
        records,
        complete: false,
        ...extra,
      }),
    );
    return storageContext.run(privateStore, () =>
      publicReplayContext.run(cdn, () =>
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
      ),
    );
  };
  const response = await put(0, [record(0), record(1)]);
  assert.equal(response.status, 200);
  const ack = await response.json();
  assert.equal(ack.through, 2);
  const first = await cdn.read("replays/" + id + "/manifest.json");
  assert.equal(first.value.count, 2);
  assert.equal(first.value.format, "neonethack.inputs");
  assert.ok(!JSON.stringify(first.value).includes(vault));
  const chunk = await cdn.read(
    "replays/" + id + "/" + first.value.chunks[0].path,
  );
  assert.deepEqual(JSON.parse(gunzipSync(chunk.value)).records, [record(0)],'creation is a small stable first scene');
  const records=[];
  for(const c of first.value.chunks)records.push(...JSON.parse(gunzipSync((await cdn.read('replays/'+id+'/'+c.path)).value)).records);
  assert.deepEqual(records,[record(0),record(1)]);
  assert.deepEqual(
    await (await put(0, [record(0), record(1)])).json(),
    ack,
    "lost acknowledgement gets the exact original cursor and hash",
  );
  assert.equal(
    (await put(0, [record(0)])).status,
    409,
    "changed duplicate cannot replace an acknowledged range",
  );
  assert.equal((await put(3, [record(3)])).status, 409, "gaps are rejected");
  assert.equal(
    (await put(2, [record(2)], {}, randomUUID())).status,
    403,
    "readable URL grants no write authority",
  );
  assert.equal(
    (await put(2, [record(2)], { buildId: "c".repeat(64) })).status,
    409,
    "runtime pin cannot change",
  );
  assert.equal((await put(2, [record(2)], { complete: true })).status, 200);
  assert.equal(
    (await put(3, [record(3)])).status,
    409,
    "a concluded archive cannot grow",
  );
  const final = await cdn.read("replays/" + id + "/manifest.json");
  assert.equal(final.value.count, 3);
  assert.equal(final.value.complete, true);
  assert.deepEqual(
    await cdn.read("replays/" + id + "/" + first.value.chunks[0].path),
    chunk,
    "prior CDN bytes remain immutable",
  );
  const checkpoint = async (index, bytes, token = vault) =>
    storageContext.run(privateStore, () =>
      publicReplayContext.run(cdn, () =>
        protocolCheckpoint(
          new Request("https://neohack.dev/api/runs/" + id + "/checkpoint", {
            method: "PUT",
            headers: {
              authorization: "Bearer " + token,
              "x-checkpoint-index": String(index),
              "x-content-sha256": hash(bytes),
            },
            body: bytes,
          }),
          id,
        ),
      ),
    );
  const bytes = gzipSync(
    "opaque checkpoint package handled only by the pinned browser runtime",
  );
  assert.equal(
    (await checkpoint(4, bytes)).status,
    409,
    "checkpoint cannot exceed acknowledged inputs",
  );
  assert.equal((await checkpoint(2, bytes, randomUUID())).status, 403);
  assert.equal((await checkpoint(2, bytes)).status, 200);
  assert.equal(
    (await checkpoint(2, bytes)).status,
    200,
    "exact checkpoint retry is idempotent",
  );
  assert.equal(
    (await checkpoint(2, Buffer.alloc(4 * 1024 * 1024 + 1))).status,
    413,
  );
  const indexed = await cdn.read("replays/" + id + "/manifest.json");
  assert.equal(indexed.value.checkpoints.length, 1);
  assert.deepEqual(
    indexed.value.chunks,
    final.value.chunks,
    "checkpoint publication cannot rewrite authoritative input descriptors",
  );
});

test("malformed, corrupt and oversized compressed payloads are refused before publication", async () => {
  const privateStore = new MemoryStorage(),
    cdn = new MemoryStorage(),
    vault = randomUUID();
  const send = (bytes, checksum = hash(bytes)) =>
    storageContext.run(privateStore, () =>
      publicReplayContext.run(cdn, () =>
        protocolReplay(
          new Request("https://neohack.dev/api/runs/" + id + "/inputs", {
            method: "PUT",
            headers: {
              authorization: "Bearer " + vault,
              "x-content-sha256": checksum,
            },
            body: bytes,
          }),
          id,
        ),
      ),
    );
  assert.equal((await send(Buffer.alloc(512 * 1024 + 1))).status, 413);
  assert.equal((await send(Buffer.from("broken"))).status, 400);
  assert.equal(
    (await send(gzipSync(Buffer.alloc(1024 * 1024 + 1)))).status,
    400,
    "decompression is bounded",
  );
  assert.equal((await send(gzipSync("{}"), "0".repeat(64))).status, 400);
  assert.equal(cdn.docs.size, 0);
  assert.equal(privateStore.docs.size, 0);
});

test("a publication failure keeps the committed cursor and exact retry finishes static publication", async () => {
  const store = new MemoryStorage(),
    cdn = new MemoryStorage(),
    vault = randomUUID();
  await store.write("vaults/" + vault + "/adventures.json", {
    values: [{ id, buildId, role: "wizard" }],
  });
  const bytes = gzipSync(
    JSON.stringify({
      format: "neonethack.inputs",
      version: 1,
      id,
      buildId,
      from: 0,
      records: [record(0)],
      complete: false,
    }),
  );
  const write = cdn.write.bind(cdn);
  let fail = true;
  cdn.write = async (path, ...args) => {
    if (fail && path.endsWith("/manifest.json"))
      throw Error("network unavailable");
    return write(path, ...args);
  };
  const send = () =>
    storageContext.run(store, () =>
      publicReplayContext.run(cdn, () =>
        protocolReplay(
          new Request("https://neohack.dev/api/runs/" + id + "/inputs", {
            method: "PUT",
            headers: {
              authorization: "Bearer " + vault,
              "x-content-sha256": hash(bytes),
            },
            body: bytes,
          }),
          id,
        ),
      ),
    );
  await assert.rejects(send(), /network unavailable/);
  assert.equal((await store.read("input-runs/" + id + ".json")).value.count, 1);
  fail = false;
  assert.equal((await send()).status, 200);
  assert.equal(
    (await cdn.read("replays/" + id + "/manifest.json")).value.count,
    1,
  );
});

test("an older publisher cannot roll back a newer input prefix or checkpoint", async () => {
  const store = new MemoryStorage(),
    cdn = new MemoryStorage(),
    vault = randomUUID();
  await store.write("vaults/" + vault + "/adventures.json", {
    values: [{ id, buildId, role: "wizard" }],
  });
  const scope = (fn) =>
    storageContext.run(store, () => publicReplayContext.run(cdn, fn));
  const send = (index) => {
    const bytes = gzipSync(
      JSON.stringify({
        format: "neonethack.inputs",
        version: 1,
        id,
        buildId,
        from: index,
        records: [record(index)],
        complete: false,
      }),
    );
    return scope(() =>
      protocolReplay(
        new Request("https://neohack.dev/api/runs/" + id + "/inputs", {
          method: "PUT",
          headers: {
            authorization: "Bearer " + vault,
            "x-content-sha256": hash(bytes),
          },
          body: bytes,
        }),
        id,
      ),
    );
  };
  assert.equal((await send(0)).status, 200);
  const read = cdn.read.bind(cdn);
  let release, entered;
  const gate = new Promise((r) => (release = r)),
    paused = new Promise((r) => (entered = r));
  let hold = true;
  cdn.head = async (path) => {
    const current = await read(path);
    if (hold && path.endsWith("/manifest.json")) {
      hold = false;
      entered();
      await gate;
    }
    return current ? { etag: current.etag } : null;
  };
  const older = send(1);
  await paused;
  assert.equal((await send(2)).status, 200);
  const bytes = gzipSync("an opaque parked runtime checkpoint");
  assert.equal(
    (
      await scope(() =>
        protocolCheckpoint(
          new Request("https://neohack.dev/api/runs/" + id + "/checkpoint", {
            method: "PUT",
            headers: {
              authorization: "Bearer " + vault,
              "x-checkpoint-index": "3",
              "x-content-sha256": hash(bytes),
            },
            body: bytes,
          }),
          id,
        ),
      )
    ).status,
    200,
  );
  const newer = await read("replays/" + id + "/manifest.json");
  release();
  assert.equal((await older).status, 200);
  assert.deepEqual(
    (await read("replays/" + id + "/manifest.json")).value,
    newer.value,
    "old publication cannot replace either the newer cursor or checkpoint index",
  );
  assert.equal(newer.value.count, 3);
  assert.equal(newer.value.checkpoints.length, 1);
});

test("a new upload authority cannot claim a previously published run identifier", async () => {
  const store = new MemoryStorage(),
    cdn = new MemoryStorage(),
    vault = randomUUID();
  const published = { version: 1, count: 17, chunks: ["chunks/old.json"] };
  await cdn.write("replays/" + id + "/manifest.json", published);
  await store.write("vaults/" + vault + "/adventures.json", {
    values: [{ id, buildId, role: "wizard" }],
  });
  const bytes = gzipSync(
    JSON.stringify({
      format: "neonethack.inputs",
      version: 1,
      id,
      buildId,
      from: 0,
      records: [record(0)],
      complete: false,
    }),
  );
  const result = await storageContext.run(store, () =>
    publicReplayContext.run(cdn, () =>
      protocolReplay(
        new Request("https://neohack.dev/api/runs/" + id + "/inputs", {
          method: "PUT",
          headers: {
            authorization: "Bearer " + vault,
            "x-content-sha256": hash(bytes),
          },
          body: bytes,
        }),
        id,
      ),
    ),
  );
  assert.equal(result.status, 409);
  assert.deepEqual(
    (await cdn.read("replays/" + id + "/manifest.json")).value,
    published,
  );
  assert.equal(await store.read("input-runs/" + id + ".json"), null);
});

test("fresh-device resume resolves immutable acknowledged data even while the CDN alias is stale", async () => {
  const store = new MemoryStorage(),
    cdn = new MemoryStorage(),
    vault = randomUUID();
  await store.write("vaults/" + vault + "/adventures.json", {
    values: [{ id, buildId, role: "wizard" }],
  });
  const invoke = (request) =>
    storageContext.run(store, () =>
      publicReplayContext.run(cdn, () => protocolReplay(request, id)),
    );
  const endpoint = "https://neohack.dev/api/runs/" + id + "/inputs";
  const send = async (index) => {
    const bytes = gzipSync(
      JSON.stringify({
        format: "neonethack.inputs",
        version: 1,
        id,
        buildId,
        from: index,
        records: [record(index)],
        complete: false,
      }),
    );
    return (
      await invoke(
        new Request(endpoint, {
          method: "PUT",
          headers: {
            authorization: "Bearer " + vault,
            "x-content-sha256": hash(bytes),
          },
          body: bytes,
        }),
      )
    ).json();
  };
  const first = await send(0),
    old = await cdn.read("replays/" + id + "/manifest.json");
  const next = await send(1);
  assert.notEqual(first.manifest, next.manifest);
  assert.match(next.manifest, /manifest-[a-f0-9]{64}\.json$/);
  const immutablePath = new URL(next.manifest).pathname.slice(
      "/replay-files/".length,
    ),
    latest = await cdn.read(immutablePath);
  assert.equal(latest.value.count, 2);
  assert.equal(
    hash(JSON.stringify(latest.value)),
    next.manifest.match(/manifest-([a-f0-9]{64})/)[1],
  );
  const read = cdn.read.bind(cdn);
  cdn.read = async (path) =>
    path.endsWith("/manifest.json") ? old : read(path);
  // Simulate a stale public read. CAS still rejects overwriting the newer alias;
  // immutable publication itself must stay available for exact-prefix restore.
  const response = await invoke(
    new Request(endpoint, { headers: { authorization: "Bearer " + vault } }),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).manifest, next.manifest);
  assert.equal((await invoke(new Request(endpoint))).status, 401);
  assert.equal(
    (
      await invoke(
        new Request(endpoint, {
          headers: { authorization: "Bearer " + randomUUID() },
        }),
      )
    ).status,
    403,
  );
  assert.deepEqual(await cdn.read(immutablePath), latest);
  // Vercel's public get(useCache:false) still reads its CDN. The management
  // head API supplies the current CAS token without downloading cached content.
  cdn.head = async (path) => {
    const current = await read(path);
    return current ? { etag: current.etag } : null;
  };
  const third = await send(2);
  assert.match(third.manifest, /manifest-[a-f0-9]{64}\.json$/);
  const checkpoint = gzipSync("parked runtime checkpoint");
  const responseCheckpoint = await storageContext.run(store, () =>
    publicReplayContext.run(cdn, () =>
      protocolCheckpoint(new Request(endpoint.replace(/inputs$/, "checkpoint"), {
        method: "PUT",
        headers: {
          authorization: "Bearer " + vault,
          "x-checkpoint-index": "3",
          "x-content-sha256": hash(checkpoint),
        },
        body: checkpoint,
      }), id),
    ),
  );
  assert.equal(responseCheckpoint.status, 200);
  const published = await read("replays/" + id + "/manifest.json");
  assert.equal(published.value.count, 3);
  assert.equal(published.value.checkpoints.length, 1);
  assert.notEqual((await responseCheckpoint.json()).manifest, third.manifest);
});
