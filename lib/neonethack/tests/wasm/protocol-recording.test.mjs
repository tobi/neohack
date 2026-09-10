import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { WasmTransport } from "../../dist/typescript/wasm.js";
import { digest } from "../../wasm/protocol-recording.mjs";
import { serveExample } from "../../scripts/serve-example.mjs";

const creation = { id: "replayfixture001", epoch: 1700000000 };
// Sixteen random-token-shaped characters; deterministic test identity only.
const create = {
  index: 0,
  creation,
  request: {
    version: 1,
    method: "session.create",
    params: { seed: 9, name: "Replay", role: "valkyrie" },
  },
};
const call = (method, state, requestId, extra = {}) => ({
  version: 1,
  method,
  params: {
    sessionId: state.sessionId,
    requestId,
    expectedRevision: state.revision,
    ...extra,
  },
});

test(
  "protocol-only replay and a real checkpoint preserve decisions, RNG outcomes and old exact receipts",
  { timeout: 120000 },
  async (t) => {
    const live = await WasmTransport.create(),
      replay = await WasmTransport.create();
    t.after(async () => {
      await live.close();
      await replay.close();
    });
    let state,
      index = 0;
    const records = [];
    async function step(request, identity) {
      const record = {
        index: index++,
        request,
        ...(identity ? { creation: identity } : {}),
      };
      const result = await live.playback(record);
      record.digest = await digest(JSON.stringify(result));
      record.integrity = await live.integrity();
      assert.deepEqual(await replay.playback(record), result);
      records.push(record);
      state = result;
      return result;
    }
    await step(create.request, creation);
    const first = await step(call("game.wait", state, "first"));
    for (let n = 0; n < 36; n++) {
      await step(call("game.pray", state, "ask-" + n));
      assert.equal(state.decision.kind, "confirmation");
      await step(
        call("decision.cancel", state, "cancel-" + n, {
          decisionId: state.decision.id,
        }),
      );
    }
    const receipt = {
      version: 1,
      method: "session.receipt",
      params: { sessionId: state.sessionId, requestId: "first" },
    };
    assert.deepEqual(
      await live.send(receipt),
      first,
      "a cold receipt is reconstructed from inputs, never executed in the live engine",
    );
    await step(call("game.eat", state, "food"));
    assert.equal(state.decision.kind, "item");
    const checkpoint = await live.checkpoint(index);
    assert.ok(
      !checkpoint.core.files.nodes.some((n) =>
        n.path.endsWith("/perceptions.jsonl"),
      ),
      "no full-response journal remains in the process",
    );
    const resumed = await WasmTransport.create();
    t.after(() => resumed.close());
    await resumed.restoreCheckpoint(checkpoint);
    assert.deepEqual(
      await resumed.send({
        version: 1,
        method: "session.observe",
        params: { sessionId: state.sessionId },
      }),
      await live.send({
        version: 1,
        method: "session.observe",
        params: { sessionId: state.sessionId },
      }),
    );
    for (let n = 0; n < 8; n++) {
      const request =
        n === 0
          ? call("decision.cancel", state, "decline-food", {
              decisionId: state.decision.id,
            })
          : call("game.wait", state, "suffix-" + n);
      const expected = await step(request);
      assert.deepEqual(
        await resumed.playback(records.at(-1)),
        expected,
        "checkpoint suffix equals replay from creation",
      );
    }
    const invalid = structuredClone(records.at(-1));
    invalid.index = index;
    invalid.digest = "0".repeat(64);
    await assert.rejects(resumed.playback(invalid), /Replay differs/);
  },
);

async function browserFixture(t) {
  const server = await serveExample();
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
    headless: true,
    chromiumSandbox: true,
  });
  t.after(async () => {
    await browser.close();
    await new Promise((r) => {
      server.close(r);
      server.closeAllConnections();
    });
  });
  const page = await browser.newPage();
  await page.goto(
    `http://127.0.0.1:${server.address().port}/lib/neonethack/docs/REPLAY.md`,
  );
  return page;
}

test(
  "real IndexedDB inputs survive worker loss and finish a reserved input exactly once",
  { timeout: 90000 },
  async (t) => {
    const page = await browserFixture(t);
    const result = await page.evaluate(async () => {
      const { WasmTransport } =
        await import("/lib/neonethack/dist/typescript/wasm.js");
      const { openProtocolStore } =
        await import("/lib/neonethack/dist/wasm/protocol-store.mjs");
      const options = {
        storage: { kind: "journal", name: "protocol-resume-fixture" },
      };
      let transport = await WasmTransport.create(options);
      const first = await transport.send({
        version: 1,
        method: "session.create",
        params: { seed: 42, role: "wizard" },
      });
      if (!first.sessionId) throw Error(JSON.stringify(first));
      const ask = {
        version: 1,
        method: "game.pray",
        params: {
          sessionId: first.sessionId,
          requestId: "ask",
          expectedRevision: first.revision,
        },
      };
      const prayer = await transport.send(ask);
      await transport.close();
      transport = await WasmTransport.create(options);
      const restored = await transport.send({
        version: 1,
        method: "session.resume",
        params: { sessionId: first.sessionId },
      });
      const receipt = await transport.send({
        version: 1,
        method: "session.receipt",
        params: { sessionId: first.sessionId, requestId: "ask" },
      });
      await transport.close();
      const store = await openProtocolStore(options.storage.name),
        header = await store.header(first.sessionId);
      // Exact state left by a crash after durable reservation but before commit.
      const reserved = {
        index: header.count,
        request: {
          version: 1,
          method: "decision.cancel",
          params: {
            sessionId: first.sessionId,
            requestId: "recover-me",
            expectedRevision: restored.revision,
            decisionId: restored.decision.id,
          },
        },
      };
      await store.reserve(first.sessionId, header.count, reserved);
      store.close();
      transport = await WasmTransport.create(options);
      const recovered = await transport.send({
        version: 1,
        method: "session.resume",
        params: { sessionId: first.sessionId },
      });
      const original = await transport.send({
        version: 1,
        method: "session.receipt",
        params: { sessionId: first.sessionId, requestId: "recover-me" },
      });
      const retried = await transport.send(reserved.request);
      const afterRetry = await transport.send({
        version: 1,
        method: "session.observe",
        params: { sessionId: first.sessionId },
      });
      await transport.close();
      return {
        prayer,
        restored,
        receipt,
        recovered,
        original,
        retried,
        afterRetry,
      };
    });
    assert.deepEqual(result.restored.observation, result.prayer.observation);
    assert.deepEqual(result.restored.decision, result.prayer.decision);
    assert.deepEqual(result.receipt, result.prayer);
    assert.equal(result.recovered.decision, null);
    assert.deepEqual(result.original, result.retried);
    assert.equal(result.afterRetry.revision, result.recovered.revision);
  },
);

test(
  "append work does not read history, including after ten thousand stored inputs",
  { timeout: 60000 },
  async (t) => {
    const page = await browserFixture(t);
    const results = await page.evaluate(async () => {
      const { openProtocolStore } =
        await import("/lib/neonethack/dist/wasm/protocol-store.mjs");
      const store = await openProtocolStore("bounded-append-fixture");
      const header = { id: "bounded", count: 0 };
      await store.create(header);
      let reads = 0;
      const originals = {};
      for (const method of [
        "get",
        "getAll",
        "getAllKeys",
        "openCursor",
        "openKeyCursor",
      ]) {
        originals[method] = IDBObjectStore.prototype[method];
        IDBObjectStore.prototype[method] = function (...args) {
          reads++;
          return originals[method].apply(this, args);
        };
      }
      const windows = [];
      try {
        for (let offset = 0; offset < 10000; offset += 1000) {
          const started = performance.now();
          for (let i = offset; i < offset + 1000; i++) {
            await store.reserve(header.id, i, {
              index: i,
              request: {
                version: 1,
                method: "game.wait",
                params: {
                  sessionId: header.id,
                  requestId: "r-" + i,
                  expectedRevision: i,
                },
              },
            });
            header.count = i + 1;
            await store.commit(header, i, {
              digest: "a".repeat(64),
              integrity: [],
            });
          }
          windows.push(performance.now() - started);
        }
      } finally {
        for (const [method, value] of Object.entries(originals))
          IDBObjectStore.prototype[method] = value;
        store.close();
      }
      return { reads, windows };
    });
    assert.equal(results.reads, 0);
    t.diagnostic(JSON.stringify(results));
  },
);

test(
  "a real level transition checkpoints, restores an exact suffix, and falls back only for derived cache corruption",
  { timeout: 120000 },
  async (t) => {
    const page = await browserFixture(t);
    const result = await page.evaluate(async () => {
      const { WasmTransport } =
        await import("/lib/neonethack/dist/typescript/wasm.js");
      const { Neonethack } =
        await import("/lib/neonethack/dist/typescript/client.js");
      const { openProtocolStore } =
        await import("/lib/neonethack/dist/wasm/protocol-store.mjs");
      const options = {
        storage: { kind: "journal", name: "level-checkpoint-fixture" },
      };
      let transport = await WasmTransport.create(options),
        api = new Neonethack(transport);
      const game = await api.create({
          role: "valkyrie",
          seed: 2,
          name: "Stairs",
        }),
        id = game.id,
        start = game.observation.location.id;
      for (
        let n = 0;
        n < 100 &&
        game.observation.location.id === start &&
        !game.state.ended &&
        !game.decision;
        n++
      ) {
        let result = await game.descend({ maxActions: 30 });
        if (result.reason === "noRoute")
          result = await game.explore({ maxActions: 30 });
        if (!result.actionsTaken) break;
      }
      if (game.observation.location.id === start)
        throw Error("Fixture did not reach stairs");
      const store = await openProtocolStore(options.storage.name);
      let checkpoint;
      for (let n = 0; n < 200 && !checkpoint; n++) {
        checkpoint = await store.checkpoint(id);
        if (!checkpoint) await new Promise((r) => setTimeout(r, 20));
      }
      if (!checkpoint)
        throw Error("Level transition did not create a checkpoint");
      await game.pray();
      const expected = game.state;
      await api.close();
      transport = await WasmTransport.create(options);
      api = new Neonethack(transport);
      const resumed = await api.resume(id),
        restored = resumed.state;
      const cancel = {
        version: 1,
        method: "decision.cancel",
        params: {
          sessionId: id,
          requestId: "after-checkpoint",
          expectedRevision: restored.revision,
          decisionId: restored.decision.id,
        },
      };
      const suffix = await transport.send(cancel);
      await api.close();
      const header = await store.header(id),
        records = await store.range(id, 0, 128);
      const replay = await WasmTransport.create();
      let whole;
      for (const record of records) whole = await replay.playback(record);
      await replay.close();
      await store.saveCheckpoint(id, { ...checkpoint, sha256: "0".repeat(64) });
      transport = await WasmTransport.create(options);
      const fallback = await transport.send({
        version: 1,
        method: "session.resume",
        params: { sessionId: id },
      });
      await transport.close();
      // Same local log with a different pin must never silently use today's engine.
      await store.updateHeader({ ...header, buildId: "0".repeat(64) });
      transport = await WasmTransport.create(options);
      let pinError;
      try {
        await transport.send({
          version: 1,
          method: "session.resume",
          params: { sessionId: id },
        });
      } catch (e) {
        pinError = String(e);
      }
      await transport.close();
      store.close();
      return {
        expected,
        restored,
        suffix,
        whole,
        fallback,
        pinError,
        checkpoint: {
          index: checkpoint.index,
          bytes: checkpoint.bytes.length,
          turn: checkpoint.turn,
        },
      };
    });
    assert.deepEqual(result.restored.observation, result.expected.observation);
    assert.deepEqual(result.restored.decision, result.expected.decision);
    assert.deepEqual(
      result.suffix,
      result.whole,
      "checkpoint continuation matches every output and RNG boundary of replay from creation",
    );
    assert.deepEqual(result.fallback.observation, result.suffix.observation);
    assert.deepEqual(result.fallback.decision, result.suffix.decision);
    assert.match(result.pinError, /original engine package/);
    assert.ok(result.checkpoint.bytes < 4 * 1024 * 1024);
    t.diagnostic(JSON.stringify(result.checkpoint));
  },
);

test(
  "missing inputs or completions cannot be disguised as an interrupted reservation",
  { timeout: 120000 },
  async (t) => {
    const page = await browserFixture(t);
    const results = await page.evaluate(async () => {
      const { WasmTransport } =
        await import("/lib/neonethack/dist/typescript/wasm.js");
      const errors = [];
      for (const [part, index] of [
        ["inputs", 1],
        ["commits", 1],
        ["commits", 2],
      ]) {
        const name = "corrupt-" + part + "-" + index,
          options = { storage: { kind: "journal", name } };
        let transport = await WasmTransport.create(options),
          s = await transport.send({
            version: 1,
            method: "session.create",
            params: { seed: 2, role: "valkyrie" },
          });
        for (let i = 0; i < 2; i++)
          s = await transport.send({
            version: 1,
            method: "game.wait",
            params: {
              sessionId: s.sessionId,
              requestId: "w-" + i,
              expectedRevision: s.revision,
            },
          });
        await transport.close();
        const db = await new Promise((resolve, reject) => {
          const r = indexedDB.open("neonethack-inputs-v1:" + name);
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
        await new Promise((resolve, reject) => {
          const tx = db.transaction(part, "readwrite");
          tx.objectStore(part).delete([s.sessionId, index]);
          tx.oncomplete = resolve;
          tx.onabort = () => reject(tx.error);
        });
        db.close();
        transport = await WasmTransport.create(options);
        try {
          await transport.send({
            version: 1,
            method: "session.resume",
            params: { sessionId: s.sessionId },
          });
          errors.push("accepted corruption");
        } catch (e) {
          errors.push(String(e));
        }
        await transport.close();
      }
      return errors;
    });
    for (const error of results)
      assert.match(
        error,
        /missing input|orphaned completions|missing completion|missing a committed completion/,
      );
  },
);

test(
  "replay verifies rejected attempts and RNG evidence without replacing the last scene",
  { timeout: 60000 },
  async (t) => {
    const live = await WasmTransport.create(),
      replay = await WasmTransport.create(), evidenceReplay = await WasmTransport.create();
    t.after(async () => {
      await live.close();
      await replay.close();
      await evidenceReplay.close();
    });
    const records = [];
    const record = async (request, identity) => {
      const r = {
        index: records.length,
        request,
        ...(identity ? { creation: identity } : {}),
      };
      const result = await live.playback(r);
      r.digest = await digest(JSON.stringify(result));
      r.integrity = await live.integrity();
      records.push(r);
      return result;
    };
    const initial = await record(create.request, creation),
      moved = await record(call("game.wait", initial, "wait"));
    const refused = await record(
      call("game.wait", moved, "stale", { expectedRevision: initial.revision }),
    );
    assert.ok(refused.error);
    assert.equal(refused.error.code, "staleRevision");
    const invalid = await record(
      call("game.notARealOperation", moved, "unknown"),
    );
    assert.ok(!invalid.observation);
    const evidence=await evidenceReplay.playbackEvidence(records);
    assert.equal(evidence.format,'neohack.replay-evidence');
    assert.deepEqual(evidence.entries.map(e=>e.index),records.map(r=>r.index));
    assert.deepEqual(evidence.entries.at(-1),{index:3,rejected:true});
    assert.equal(evidence.entries[2].revision,refused.revision);
    assert.deepEqual(await evidenceReplay.send({version:1,method:'session.receipt',params:{sessionId:moved.sessionId,requestId:'wait'}}),moved,
      'projecting story evidence leaves exact historical receipts available');
    assert.deepEqual(
      await replay.playbackBatch(records),
      refused,
      "an error without an observation retains the preceding witnessed scene",
    );
    assert.deepEqual(
      refused.observation,
      moved.observation,
      "a stale request cannot change the scene",
    );
    const next = await record(call("game.pray", moved, "next"));
    const tampered = structuredClone(records.at(-1));
    assert.ok(tampered.integrity.length);
    tampered.integrity[0].rng.core.state = "0".repeat(64);
    await assert.rejects(
      replay.playback(tampered),
      /RNG|integrity|Replay/i,
      "matching output is insufficient when RNG evidence differs",
    );
    assert.equal(next.decision.kind, "confirmation");
  },
);
