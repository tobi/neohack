import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";
import { WasmTransport } from "../../lib/neonethack/dist/typescript/wasm.js";
import { digest } from "../../lib/neonethack/wasm/protocol-recording.mjs";
import { ChronicleDigest } from "./digest.mjs";
import { collectReplay } from "./replay.mjs";

test(
  "actual static input archive replays every witnessed boundary with exact WASM pin",
  { timeout: 30000 },
  async (t) => {
    const live = await WasmTransport.create();
    t.after(() => live.close());
    const records = [];
    let s;
    const step = async (request, creation) => {
      const r = {
        index: records.length,
        request,
        ...(creation ? { creation } : {}),
      };
      s = await live.playback(r);
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
    await step(call("game.quit"));
    await step(
      call("decision.answer", {
        decisionId: s.decision.id,
        answer: { kind: "confirmation", confirm: true },
      }),
    );
    const bytes = gzipSync(
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
    const url = `http://127.0.0.1:${server.address().port}/manifest.json`,
      runtime = resolve("lib/neonethack/dist/wasm");
    const result = await collectReplay(url, new ChronicleDigest(), { runtime });
    assert.equal(result.hero.name, "Edda");
    assert.equal(result.coverage.observedReplies, 5);
    assert.equal(result.events.at(-1).ending.kind, "quit");
    assert.equal(result.events.at(-1).ending.turn, s.observation.turn);
    assert.ok(result.events.some((e) => e.action === "pray"));
    assert.ok(requests.every((x) => !x.startsWith("/api")));
    corrupt = true;
    await assert.rejects(
      collectReplay(url, new ChronicleDigest(), { runtime }),
      /checksum/,
    );
  },
);
