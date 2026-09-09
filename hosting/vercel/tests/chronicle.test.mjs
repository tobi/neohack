import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { WasmTransport } from "../../../lib/neonethack/dist/typescript/wasm.js";
import { digest as sha } from "../../../lib/neonethack/wasm/protocol-recording.mjs";
import { createTestHarness, MemoryStorage, publicStoreFor } from "./server.mjs";
import { storyModelContext, CHRONICLE_MIN_DEPTH, CHRONICLE_MIN_LEVEL } from "../src/chronicle.ts";

/** A genuine, short input archive recorded with the staged engine package. */
async function recordArchive(id, name) {
  const live = await WasmTransport.create();
  try {
    const records = [];
    let s;
    const step = async (request, creation) => {
      const r = { index: records.length, request, ...(creation ? { creation } : {}) };
      s = await live.playback(r);
      r.digest = await sha(JSON.stringify(s));
      r.integrity = await live.integrity();
      records.push(r);
    };
    await step({ version: 1, method: "session.create", params: { name, role: "valkyrie", race: "human", gender: "female", align: "lawful", seed: 9 } }, { id, epoch: 1700000000 });
    const call = (method, params = {}) => ({ version: 1, method, params: { sessionId: id, requestId: "input-" + records.length, expectedRevision: s.revision, ...params } });
    await step(call("game.pray"));
    await step(call("decision.cancel", { decisionId: s.decision.id }));
    await step(call("game.quit"));
    await step(call("decision.answer", { decisionId: s.decision.id, answer: { kind: "confirmation", confirm: true } }));
    const bytes = gzipSync(JSON.stringify({ format: "neonethack.inputs", version: 1, id, buildId: live.buildId, from: 0, records }));
    const hash = createHash("sha256").update(bytes).digest("hex");
    return { buildId: live.buildId, bytes, chunk: { path: "chunks/" + hash + ".gz", sha256: hash, bytes: bytes.length, from: 0, count: records.length }, count: records.length };
  } finally {
    await live.close();
  }
}

async function seed(store, id, archive, run) {
  await store.write("input-runs/" + id + ".json", { owner: "x", buildId: archive.buildId, count: archive.count, generation: 1, chunks: [archive.chunk], checkpoints: [], name: run.name, role: "valkyrie", seed: 9, control: "interactive", complete: true });
  await publicStoreFor(store).write("replays/" + id + "/" + archive.chunk.path, archive.bytes);
}

test("a chronicle is generated once per eligible dead hero, cached publicly and flagged in the ledger", { timeout: 120000 }, async (t) => {
  const store = new MemoryStorage(), calls = [];
  const model = async (digest) => {
    calls.push(digest);
    const ids = digest.events.map((e) => e.id), last = ids.at(-1);
    return { raw: JSON.stringify({ title: "The Valkyrie Who Considered Praying", paragraphs: [
      { text: "Edda Chronicle arrived as a Valkyrie with a little dog and, for a moment, thought about praying.", sources: [ids[0]] },
      { text: "Then she simply ended the attempt.", sources: [last] },
    ] }), usage: { total_tokens: 12 } };
  };
  const server = createTestHarness({ store, wrap: (fn) => storyModelContext.run(model, fn) });
  const { url } = await server.listen();
  t.after(() => server.close());
  const id = "chronicleRun0001", other = "chronicleRun0002", living = "chronicleRun0003";
  const archive = await recordArchive(id, "Edda Chronicle");
  await seed(store, id, archive, { name: "Edda Chronicle" });
  const post = (runs) => fetch(new URL("/api/runs", url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runs }) });
  await post([
    { id, name: "Edda Chronicle", role: "valkyrie", turn: 5, ended: true, endKind: "death", maxDepth: CHRONICLE_MIN_DEPTH, maxLevel: CHRONICLE_MIN_LEVEL, heroLevel: CHRONICLE_MIN_LEVEL },
    { id: other, name: "Shallow", role: "wizard", turn: 40, ended: true, endKind: "death", maxDepth: CHRONICLE_MIN_DEPTH - 1, maxLevel: 5 },
    { id: living, name: "Alive", role: "ranger", turn: 900, ended: false, maxDepth: 9, maxLevel: 9 },
  ]);
  const api = (run, method) => fetch(new URL("/api/runs/" + run + "/chronicle", url), { method });

  let r = await api(id, "GET");
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { available: false, eligible: true, reason: "" });
  r = await api(other, "POST");
  assert.equal(r.status, 409, "too shallow");
  assert.match((await r.json()).error, /dungeon level 3/);
  r = await api(living, "POST");
  assert.equal(r.status, 409, "still adventuring");
  r = await api("chronicleRun0009", "POST");
  assert.equal(r.status, 409, "unknown run is not in the ledger");
  assert.equal(calls.length, 0, "ineligible requests never reach the model");

  r = await api(id, "POST");
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  const doc = await r.json();
  assert.equal(doc.available, true);
  assert.equal(doc.story.title, "The Valkyrie Who Considered Praying");
  assert.equal(doc.hero.name, "Edda Chronicle");
  assert.equal(doc.coverage.complete, true, "the replay reached the recorded ending");
  assert.ok(doc.story.paragraphs[0].segments.some((s) => s.term === "valkyrie"), "witnessed names get glossary segments");
  assert.ok(doc.glossary.valkyrie?.lines.length, "glossary entries come from the pinned encyclopedia");
  assert.ok(!("little dog" in doc.glossary) || doc.story.paragraphs[0].segments.some((s) => s.term === "little dog"));
  assert.equal(calls.length, 1);
  assert.ok(calls[0].events.some((e) => e.action === "pray"), "the model saw the replayed evidence");

  const cached = publicStoreFor(store).docs.get("chronicles/" + id + "/story.json");
  assert.ok(cached, "the story is a public object");
  assert.equal(cached.value.evidenceHash, doc.evidenceHash);
  r = await api(id, "POST");
  assert.equal(r.status, 200);
  assert.equal(calls.length, 1, "a second request serves the cache without paying for a model call");
  r = await api(id, "GET");
  assert.equal(r.status, 200);
  assert.equal((await r.json()).story.title, doc.story.title);

  const stats = await (await fetch(new URL("/api/stats", url))).json();
  const listed = stats.best.find((x) => x.id === id);
  assert.equal(listed.chronicleAvailable, true);
  assert.equal(stats.best.find((x) => x.id === other).chronicleAvailable, false);
});

test("the ledger shows a chronicle icon, opens the tale with dotted encyclopedia names, and tells a new tale from the replay lightbox", { timeout: 180000 }, async (t) => {
  const { chromium } = await import("../../../web/neohack.dev/node_modules/playwright-core/index.mjs");
  const store = new MemoryStorage(), calls = [];
  const model = async (digest) => {
    calls.push(digest);
    return { raw: JSON.stringify({ title: "Tale " + digest.hero.name, paragraphs: [
      { text: digest.hero.name + " was a Valkyrie with a little dog who thought about praying.", sources: [digest.events[0].id] },
      { text: "The end came quietly.", sources: [digest.events.at(-1).id] },
    ] }) };
  };
  const server = createTestHarness({ store, wrap: (fn) => storyModelContext.run(model, fn) });
  const { url } = await server.listen();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", headless: true, chromiumSandbox: true });
  t.after(async () => { await browser.close(); await server.close(); });
  const told = "chronicleRun0006", fresh = "chronicleRun0007";
  for (const [id, name] of [[told, "Told Already"], [fresh, "Fresh Hero"]]) await seed(store, id, await recordArchive(id, name), { name });
  await fetch(new URL("/api/runs", url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runs: [
    { id: told, name: "Told Already", role: "valkyrie", turn: 5, ended: true, endKind: "death", maxDepth: 5, maxLevel: 4 },
    { id: fresh, name: "Fresh Hero", role: "valkyrie", turn: 5, ended: true, endKind: "death", maxDepth: 3, maxLevel: 2 },
  ] }) });
  await fetch(new URL("/api/runs/" + told + "/chronicle", url), { method: "POST" });
  assert.equal(calls.length, 1);
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(new URL("/dashboard", url).href);
  await page.waitForSelector("#runs tr");
  const toldRow = page.locator("#runs tr", { hasText: "Told Already" }), freshRow = page.locator("#runs tr", { hasText: "Fresh Hero" });
  await assert.doesNotReject(toldRow.getByRole("button", { name: "Show replay for Told Already" }).waitFor());
  assert.equal(await freshRow.locator(".run-chronicle").count(), 0, "no icon before a tale exists");
  await toldRow.getByRole("button", { name: "Read the chronicle of Told Already" }).click();
  await page.waitForSelector("#chronicle-lightbox[open]");
  assert.equal(await page.locator("#chronicle-lightbox .chronicle-title").textContent(), "Tale Told Already");
  const term = page.locator("#chronicle-lightbox .lore-link", { hasText: "Valkyrie" });
  assert.ok(await term.count(), "witnessed names are dotted lookups");
  await term.first().click();
  await page.waitForSelector("#chronicle-lightbox .chronicle-lore:not([hidden])");
  assert.match(await page.locator("#chronicle-lightbox .chronicle-lore h3").textContent(), /valkyrie/i);
  assert.ok((await page.locator("#chronicle-lightbox .chronicle-lore p").first().textContent()).length > 20, "encyclopedia text is shown inline");
  await page.getByRole("button", { name: "Close chronicle" }).click();

  await freshRow.getByRole("button", { name: "Show replay for Fresh Hero" }).click();
  await page.waitForSelector("#replay-lightbox[open]");
  const tell = page.getByRole("button", { name: "Tell the tale of Fresh Hero" });
  await tell.click();
  await page.waitForSelector("#chronicle-lightbox[open]", { timeout: 60000 });
  assert.equal(calls.length, 2, "the lightbox button asked the chronicler once");
  assert.equal(await page.locator("#chronicle-lightbox .chronicle-title").textContent(), "Tale Fresh Hero");
  await page.getByRole("button", { name: "Close chronicle" }).click();
  await page.getByRole("button", { name: "Refresh" }).click();
  await freshRow.getByRole("button", { name: "Read the chronicle of Fresh Hero" }).waitFor();

  await page.goto(new URL("/dashboard?run=" + told + "&view=chronicle", url).href);
  await page.waitForSelector("#chronicle-lightbox[open]");
  assert.equal(await page.locator("#chronicle-lightbox .chronicle-title").textContent(), "Tale Told Already");
  assert.equal(calls.length, 2, "views never regenerate");
  assert.deepEqual(errors, []);
});

test("a model failure releases the claim, is never retried automatically and leaves no story", { timeout: 120000 }, async (t) => {
  const store = new MemoryStorage();
  let attempts = 0;
  const model = async () => { attempts++; throw Error("Story model request failed (503); not retried automatically."); };
  const server = createTestHarness({ store, wrap: (fn) => storyModelContext.run(model, fn) });
  const { url } = await server.listen();
  t.after(() => server.close());
  const id = "chronicleRun0004";
  await seed(store, id, await recordArchive(id, "Unlucky"), { name: "Unlucky" });
  await fetch(new URL("/api/runs", url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runs: [{ id, name: "Unlucky", role: "valkyrie", turn: 5, ended: true, endKind: "death", maxDepth: 4, maxLevel: 3 }] }) });
  const warnings = [], warn = console.warn;
  console.warn = (line) => warnings.push(line);
  t.after(() => { console.warn = warn; });
  let r = await fetch(new URL("/api/runs/" + id + "/chronicle", url), { method: "POST" });
  assert.equal(r.status, 502);
  assert.equal(attempts, 1);
  assert.ok(!publicStoreFor(store).docs.has("chronicles/" + id + "/story.json"));
  assert.ok(warnings.some((w) => JSON.parse(w).event === "chronicle_failed" && JSON.parse(w).stage === "model"));
  assert.ok(warnings.every((w) => !w.includes("503)")), "raw model errors stay out of logs");
  r = await fetch(new URL("/api/runs/" + id + "/chronicle", url), { method: "POST" });
  assert.equal(r.status, 502, "the released claim allows a later explicit retry");
  assert.equal(attempts, 2);
  const stats = await (await fetch(new URL("/api/stats", url))).json();
  assert.equal(stats.best.find((x) => x.id === id).chronicleAvailable, false);
});

test("without a model credential the endpoint refuses before replaying anything", async (t) => {
  const store = new MemoryStorage();
  const server = createTestHarness({ store });
  const { url } = await server.listen();
  t.after(() => server.close());
  const saved = { VERCEL_OIDC_TOKEN: process.env.VERCEL_OIDC_TOKEN, AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY };
  delete process.env.VERCEL_OIDC_TOKEN; delete process.env.AI_GATEWAY_API_KEY;
  t.after(() => { for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v; });
  const id = "chronicleRun0005";
  await fetch(new URL("/api/runs", url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runs: [{ id, name: "Keyless", role: "valkyrie", turn: 5, ended: true, endKind: "death", maxDepth: 4, maxLevel: 3 }] }) });
  const r = await fetch(new URL("/api/runs/" + id + "/chronicle", url), { method: "POST" });
  assert.equal(r.status, 503);
  assert.equal(publicStoreFor(store).docs.size, 0, "no claim or story is written");
});
