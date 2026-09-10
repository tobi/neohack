import "./no-model-calls.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";
import { readFile, rm, mkdtemp, cp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { WasmTransport } from "../../lib/neonethack/dist/typescript/wasm.js";
import { digest } from "../../lib/neonethack/wasm/protocol-recording.mjs";
import { ChronicleDigest } from "./digest.mjs";
import { collectReplay, packageAt } from "./replay.mjs";

test(
  "actual static input archive replays every witnessed boundary with exact WASM pin",
  { timeout: 30000 },
  async (t) => {
    const runtime = await mkdtemp(
      resolve(tmpdir(), "chronicle-pinned-runtime-"),
    );
    await cp(resolve("lib/neonethack/dist/wasm"), runtime, { recursive: true });
    // Simulate an archived host without the new message. All compiler outputs
    // and static game data remain byte-identical and bound by this package pin.
    const manifestPath = resolve(runtime, "manifest.json"),
      pin = JSON.parse(await readFile(manifestPath, "utf8"));
    const obsolete = 'throw Error("The archived worker must not run");';
    await writeFile(resolve(runtime, "core-worker.mjs"), obsolete);
    pin.files["core-worker.mjs"] = await digest(obsolete);
    pin.buildId = await digest(JSON.stringify(pin.files));
    await writeFile(manifestPath, JSON.stringify(pin));
    const options = {
      runtimeUrl: pathToFileURL(runtime + "/").href,
      workerUrl: new URL(
        "../../lib/neonethack/wasm/core-worker.mjs",
        import.meta.url,
      ),
    };
    const live = await WasmTransport.create(options);
    t.after(() => live.close());
    t.after(() => rm(runtime, { recursive: true, force: true }));
    const records = [],
      replies = [];
    const expected = new ChronicleDigest({
      name: "Edda",
      role: "valkyrie",
      race: "human",
    });
    let s;
    const step = async (request, creation) => {
      const r = {
        index: records.length,
        request,
        ...(creation ? { creation } : {}),
      };
      s = await live.playback(r);
      replies.push(s);
      expected.add(s);
      r.digest = await digest(JSON.stringify(s));
      r.integrity = await live.integrity();
      records.push(r);
    };
    const id = "chroniclefixture";
    await step(
      {
        version: 1,
        method: "session.create",
        params: {
          name: "Edda",
          role: "valkyrie",
          race: "human",
          gender: "female",
          align: "lawful",
          seed: 9,
        },
      },
      { id, epoch: 1700000000 },
    );
    const call = (method, params = {}) => ({
      version: 1,
      method,
      params: {
        sessionId: id,
        requestId: "input-" + records.length,
        expectedRevision: s.revision,
        ...params,
      },
    });
    await step(call("game.pray"));
    await step(call("decision.cancel", { decisionId: s.decision.id }));
    await step(call("game.search", { turns: 1 }));
    for (let i = 0; i < 64; i++) {
      await step(call("game.pray"));
      await step(call("decision.cancel", { decisionId: s.decision.id }));
    }
    await step(call("game.quit"));
    await step(
      call("decision.answer", {
        decisionId: s.decision.id,
        answer: { kind: "confirmation", confirm: true },
      }),
    );
    let bytes = gzipSync(
        JSON.stringify({
          format: "neonethack.inputs",
          version: 1,
          id,
          buildId: live.buildId,
          from: 0,
          records,
        }),
      ),
      sha256 = await digest(bytes);
    const manifest = {
      format: "neonethack.inputs",
      version: 1,
      id,
      buildId: live.buildId,
      count: records.length,
      complete: true,
      chunks: [
        {
          from: 0,
          count: records.length,
          bytes: bytes.length,
          sha256,
          path: `chunks/${sha256}.gz`,
        },
      ],
    };
    const requests = [];
    let corrupt = false;
    const server = createServer((req, res) => {
      requests.push(req.url);
      if (req.url === "/manifest.json") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(manifest));
      } else if (req.url === `/chunks/${sha256}.gz`)
        res.end(corrupt ? Buffer.from("damaged") : bytes);
      else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(
      () =>
        new Promise((r) => {
          server.closeAllConnections();
          server.close(r);
        }),
    );
    const url = `http://127.0.0.1:${server.address().port}/manifest.json`;
    const progress = [],
      timings = [];
    const result = await collectReplay(url, new ChronicleDigest(), {
      runtime,
      onProgress: (done, total) => progress.push([done, total]),
      onTiming: (value) => timings.push(value),
    });
    assert.deepEqual(
      result,
      expected.finish(),
      "batch evidence yields exactly the same story input as every full public reply",
    );
    assert.equal(result.hero.name, "Edda");
    assert.equal(result.coverage.observedReplies, records.length);
    assert.equal(result.events.at(-1).ending.kind, "quit");
    assert.equal(result.events.at(-1).ending.turn, s.observation.turn);
    assert.ok(result.events.some((e) => e.action === "pray"));
    assert.ok(requests.every((x) => !x.startsWith("/api")));
    assert.deepEqual(progress, [
      [0, records.length],
      [128, records.length],
      [records.length, records.length],
    ]);
    assert.equal(timings.length, 1);
    assert.equal(timings[0].batches, 2);
    assert.equal(timings[0].completedInputs, records.length);
    assert.equal(timings[0].chunks, 1);
    for (const [key, value] of Object.entries(timings[0]))
      if (key.endsWith("Ms"))
        assert.ok(Number.isFinite(value) && value >= 0, key);
    const projected = await WasmTransport.create(options);
    try {
      const evidence = await projected.playbackEvidence(records.slice(0, 128));
      assert.equal(evidence.entries.length, 128);
      assert.ok(
        Buffer.byteLength(JSON.stringify(evidence)) <
          Buffer.byteLength(JSON.stringify(replies.slice(0, 128))) / 4,
        "worker transfer omits large maps and inventory without dropping the story evidence",
      );
      assert.ok(
        evidence.entries.every(
          (e) =>
            !("world" in e.observation) &&
            !("inventory" in e.observation) &&
            !("version" in e),
        ),
      );
    } finally {
      await projected.close();
    }
    corrupt = true;
    await assert.rejects(
      collectReplay(url, new ChronicleDigest(), { runtime }),
      /checksum/,
    );
    corrupt = false;
    await assert.rejects(
      collectReplay(url, new ChronicleDigest(), {
        runtime: resolve("lib/neonethack/dist/wasm"),
      }),
      /manifest differs/,
      "a different package is never substituted for the recorded pin",
    );
    for (const field of ["digest", "integrity"]) {
      const damaged = structuredClone(records);
      if (field === "digest") damaged[129].digest = "0".repeat(64);
      else {
        assert.ok(damaged[129].integrity.length);
        damaged[129].integrity[0].rng.core.state = "0".repeat(64);
      }
      bytes = gzipSync(
        JSON.stringify({
          format: "neonethack.inputs",
          version: 1,
          id,
          buildId: live.buildId,
          from: 0,
          records: damaged,
        }),
      );
      sha256 = await digest(bytes);
      Object.assign(manifest.chunks[0], {
        bytes: bytes.length,
        sha256,
        path: `chunks/${sha256}.gz`,
      });
      const prefix = new ChronicleDigest(),
        completion = [];
      await assert.rejects(
        collectReplay(url, prefix, {
          runtime,
          onProgress: (done) => completion.push(done),
        }),
        /Replay.*input 129/,
      );
      assert.equal(
        prefix.count,
        128,
        "a failed batch contributes no unverified suffix to the story",
      );
      assert.deepEqual(completion, [0, 128]);
    }
  },
);

test(
  "cold runtime assets download in bounded parallel windows and failures never publish a partial package",
  { timeout: 10000 },
  async (t) => {
    const names = [
      "core-worker.mjs",
      "neonethack-core.wasm",
      "neonethack-engine.wasm",
      "neonethack-engine.data",
      "neonethack-core.mjs",
      "neonethack-engine.mjs",
    ];
    const contents = Object.fromEntries(
      names.map((name) => [name, Buffer.from(name + crypto.randomUUID())]),
    );
    const files = Object.fromEntries(
      await Promise.all(
        names.map(async (name) => [name, await digest(contents[name])]),
      ),
    );
    const id = await digest(JSON.stringify(files)),
      dir = resolve(tmpdir(), "neohack-chronicle-runtimes", id);
    let active = 0,
      peak = 0,
      arrivals = 0,
      release,
      corrupt = true;
    let allArrived = new Promise((resolve) => (release = resolve));
    const server = createServer(async (req, res) => {
      const name = req.url.split("/").at(-1);
      if (name === "manifest.json") {
        res.end(JSON.stringify({ version: 1, buildId: id, files }));
        return;
      }
      if (contents[name]) {
        active++;
        peak = Math.max(peak, active);
        if (++arrivals === 6) release();
        await allArrived;
        res.end(
          corrupt && name === names[0] ? Buffer.from("wrong") : contents[name],
        );
        active--;
      } else res.end("Fixture notice");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    });
    const origin = `http://127.0.0.1:${server.address().port}/`;
    await assert.rejects(packageAt(id, undefined, origin), /checksum/);
    assert.equal(active, 0);
    assert.equal(peak, 6);
    await assert.rejects(readFile(resolve(dir, "manifest.json")), {
      code: "ENOENT",
    });
    corrupt = false;
    arrivals = 0;
    allArrived = new Promise((resolve) => (release = resolve));
    assert.equal(await packageAt(id, undefined, origin), dir);
    assert.equal(peak, 6);
    assert.equal(active, 0);
    for (const name of names)
      assert.deepEqual(await readFile(resolve(dir, name)), contents[name]);
    const before = arrivals;
    assert.equal(await packageAt(id, undefined, origin), dir);
    assert.equal(
      arrivals,
      before,
      "validated local package avoids another download",
    );
  },
);
