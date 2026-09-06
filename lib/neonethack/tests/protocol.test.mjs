import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { NativeTransport } from "../dist/typescript/native.js";
import { Neonethack, UncertainExecution } from "../dist/typescript/client.js";
import { tools } from "../dist/mcp/tools.js";
import Ajv from "ajv/dist/2020.js";
const root = resolve(import.meta.dirname, "..");
const catalog = JSON.parse(await readFile(`${root}/protocol/catalog.json`, "utf8"));
const validateResponse = new Ajv({ strict: false }).compile(JSON.parse(await readFile(`${root}/protocol/response.schema.json`, "utf8")));
const request = (method, params) => ({ version: 1, method, params });
async function fixture(t) {
  const sessions = await mkdtemp(`${tmpdir()}/nnh-node-`);
  const transport = new NativeTransport({ executable: `${root}/build/native/neonethack`, enginePath: `${root}/engine/playground/nethack`, dataPath: `${root}/engine/playground`, sessionsPath: sessions });
  const send = transport.send.bind(transport);
  transport.send = async req => {
    const response = await send(req);
    assert.ok(validateResponse(response), JSON.stringify(validateResponse.errors));
    return response;
  };
  t.after(async () => { await transport.close(); await rm(sessions, { recursive: true, force: true }); });
  return { sessions, transport, client: new Neonethack(transport) };
}
const identity = { name: "Library", role: "valkyrie", race: "dwarf", gender: "female", align: "lawful", seed: 42 };

test("C discovery, published catalog and MCP schemas are identical", async t => {
  const { client } = await fixture(t);
  assert.deepEqual((await client.describe()).catalog, catalog);
  assert.equal(tools.length, catalog.methods.length);
  const actionsIndex=catalog.methods.findIndex(m=>m.name === "session.actions");
  assert.equal(tools[actionsIndex].annotations.readOnlyHint,true);
  assert.equal(tools[actionsIndex].annotations.idempotentHint,true);
  const ajv = new Ajv({ strict: false });
  for (const [i, method] of catalog.methods.entries()) {
    assert.deepEqual(tools[i].inputSchema, method.schema);
    assert.ok(ajv.compile(method.schema));
    assert.equal(method.schema.additionalProperties, false);
    assert.equal("tool" in method, false);
  }
});

test("high-level moves, typed decisions, safe retries and pending cold resume", async t => {
  const { transport, client } = await fixture(t);
  const game = await client.create(identity);
  const initial = game.observation;
  assert.ok(Object.isFrozen(initial));
  const [one, two] = await Promise.all([game.wait(), game.wait()]);
  assert.ok(two.revision > one.revision);
  assert.equal(two.observation.turn, initial.turn + 2);
  const candidates = await game.eat();
  assert.equal(candidates.decision.kind, "item");
  assert.equal(candidates.outcome.turnsElapsed, 0);
  const rejected = await client.request("decision.answer", { sessionId: game.id, requestId: "bad-kind", expectedRevision: candidates.revision, decisionId: candidates.decision.id, answer: { kind: "confirmation", confirm: false } });
  assert.ok(rejected.error);
  assert.equal((await game.observe()).decision.id, candidates.decision.id);
  await game.cancel(candidates.decision.id);
  const prayer = await game.pray();
  assert.equal(prayer.decision.kind, "confirmation");
  const before = prayer.observation;
  await game.close();
  const resumed = await client.resume(game.id);
  assert.deepEqual(resumed.observation, before);
  assert.deepEqual(resumed.decision, prayer.decision);
  const answer = request("decision.answer", { sessionId: game.id, requestId: "consent-no", expectedRevision: resumed.state.revision, decisionId: resumed.decision.id, answer: { kind: "confirmation", confirm: false } });
  const declined = await transport.send(answer);
  assert.equal(declined.error, undefined);
  assert.equal(declined.decision, null);
  assert.deepEqual(await transport.send(answer), declined);
});

test("malformed fields and mixed decision answers never change state", async t => {
  const { client, transport } = await fixture(t);
  const game = await client.create(identity);
  const before = await game.observe();
  const base = { sessionId: game.id, requestId: "invalid", expectedRevision: before.revision };
  const bad = [
    request("game.wait", { ...base, direction: "north" }),
    request("game.move", { ...base, direction: "up" }),
    request("game.zap", { ...base, target: "here" }),
    request("game.apply", { ...base, target: "self" }),
    request("decision.answer", { ...base, decisionId: "decision-1", answer: { kind: "confirmation", confirm: false, text: "no" } }),
    request("decision.answer", { ...base, decisionId: "decision-1", answer: { kind: "choice", choose: [1, 1] } }),
    request("decision.cancel", { ...base, decisionId: "decision-1", answer: { kind: "text", text: "oops" } }),
    request("game.eat", { ...base, item: { id: "item-1", letter: "a" } }),
    request("game.wait", { ...base, expectedRevision: null }),
    request("game.wait", { sessionId: game.id }),
  ];
  for (const invalid of bad) assert.equal((await transport.send(invalid)).error.code, "invalidParams");
  assert.deepEqual(await game.observe(), before);
});

test("a lost reply blocks new operations and retries exactly once", async t => {
  const { transport } = await fixture(t);
  let drop = true;
  const client = new Neonethack({
    async send(req) {
      const response = await transport.send(req);
      if (req.method === "game.wait" && drop) { drop = false; throw Error("simulated dropped reply after actual execution"); }
      return response;
    }, close: () => transport.close(),
  });
  const game = await client.create(identity);
  const turn = game.observation.turn;
  await assert.rejects(game.wait(), UncertainExecution);
  const pending = game.pendingRequest;
  await assert.rejects(game.move("east"), UncertainExecution);
  assert.strictEqual(game.pendingRequest, pending);
  assert.equal((await game.observe()).observation.turn, turn + 1);
  const recovered = await game.retry();
  assert.equal(recovered.observation.turn, turn + 1);
  assert.equal(game.pendingRequest, null);
  assert.equal((await game.wait()).observation.turn, turn + 2);
});
