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

/** NDJSON lines with the time each arrived, so incremental delivery is checked. */
const readLines = async (response, until = () => false) => {
  const events = [], reader = response.body.getReader(), decoder = new TextDecoder(), started = Date.now();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      events.push(Object.assign(JSON.parse(buffer.slice(0, i)), { at: Date.now() - started }));
      buffer = buffer.slice(i + 1);
      if (until(events)) { await reader.cancel(); return events; }
    }
  }
  return events;
};
const markdownTale = (digest, title) =>
  `# ${title}\n\n${digest.hero.name} was a Valkyrie with a little dog who thought about praying. [${digest.events[0].id}]\n\nThe end came quietly. [${digest.events.at(-1).id}]\n`;

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

test("ledger links lead to each run's page, which shows the tale with anchored encyclopedia popovers or tells a new one as it is written", { timeout: 180000 }, async (t) => {
  const { chromium } = await import("../../../web/neohack.dev/node_modules/playwright-core/index.mjs");
  const store = new MemoryStorage(), calls = [];
  // The double writes the heading and first words, then waits for the test to
  // look at the page before finishing, so the draft state is observed exactly.
  let release = () => {};
  const gate = new Promise((r) => { release = r; });
  const model = async (digest, { onDelta }) => {
    calls.push(digest);
    const text = markdownTale(digest, "Tale " + digest.hero.name);
    const cut = text.indexOf("little dog");
    onDelta(text.slice(0, cut), text.slice(0, cut));
    if (calls.length === 2) await gate;
    onDelta(text.slice(cut), text);
    return { raw: text };
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
  // Ledger rows link to each run's own page; the scroll icon deep-links to its story.
  assert.equal(await toldRow.getByRole("link", { name: "Show replay for Told Already" }).getAttribute("href"), new URL("/replays/" + told, url).href);
  assert.equal(await freshRow.locator(".run-chronicle").count(), 0, "no icon before a tale exists");
  assert.equal(await toldRow.getByRole("link", { name: "Read the chronicle of Told Already" }).getAttribute("href"), new URL("/replays/" + told + "?view=chronicle", url).href);
  await toldRow.getByRole("link", { name: "Read the chronicle of Told Already" }).click();
  await page.waitForURL((u) => u.pathname === "/replays/" + told && u.searchParams.get("view") === "chronicle");
  await page.waitForSelector("#chronicle-section:not([hidden]) .chronicle:not(.chronicle-draft)");
  assert.equal(await page.locator("#chronicle-section .chronicle-title").textContent(), "Tale Told Already");
  const term = page.locator("#chronicle-section .lore-link", { hasText: "Valkyrie" });
  assert.ok(await term.count(), "witnessed names are dotted lookups");
  await term.first().click();
  await page.waitForSelector("#chronicle-section .chronicle-lore:not([hidden])");
  assert.match(await page.locator("#chronicle-section .chronicle-lore h3").textContent(), /valkyrie/i);
  assert.ok((await page.locator("#chronicle-section .chronicle-lore p").first().textContent()).length > 20, "encyclopedia text is shown in the popover");
  const [lore, anchor] = await page.evaluate(() => [document.querySelector("#chronicle-section .chronicle-lore").getBoundingClientRect().toJSON(), document.querySelector('#chronicle-section .lore-link[aria-expanded="true"]').getBoundingClientRect().toJSON()]);
  assert.ok(Math.abs(lore.top - anchor.bottom) < 24 || Math.abs(anchor.top - lore.bottom) < 24, "the popover is anchored to the tapped name");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#chronicle-section .chronicle-lore[hidden]", { state: "attached" });

  // From the ledger, Show replay goes to the run's page, where an untold tale
  // is offered and streams in as it is written.
  await page.goto(new URL("/dashboard", url).href);
  await page.waitForSelector("#runs tr");
  await freshRow.getByRole("link", { name: "Show replay for Fresh Hero" }).click();
  await page.waitForURL((u) => u.pathname === "/replays/" + fresh);
  await page.waitForSelector("#chronicle-section:not([hidden]) #tell-tale:not([hidden])");
  await page.locator("#chronicle-section #tell-tale").click();
  await page.waitForSelector("#chronicle-section .chronicle-draft", { timeout: 60000 });
  await page.waitForSelector("#chronicle-section .chronicle-draft .chronicle-paragraph", { timeout: 60000 });
  const draft = await page.locator("#chronicle-section .chronicle-draft").textContent();
  assert.match(draft, /Tale Fresh Hero.*Fresh Hero was a Valkyrie with a/s, "the title and first words appear while the chronicler is still writing");
  assert.ok(!/\[T\d/.test(draft), "citations never show in the draft");
  assert.ok(await page.locator("#chronicle-section .chronicle-writing").count(), "the open paragraph shows a writing mark");
  assert.equal(await page.evaluate(() => new URL(location.href).searchParams.get("view")), "chronicle", "telling the tale claims the story route");
  release();
  await page.waitForSelector("#chronicle-section .chronicle:not(.chronicle-draft)", { timeout: 60000 });
  assert.equal(calls.length, 2, "the page asked the chronicler once");
  assert.equal(await page.locator("#chronicle-section .chronicle-title").textContent(), "Tale Fresh Hero");
  await page.goto(new URL("/dashboard", url).href);
  await page.waitForSelector("#runs tr");
  await freshRow.getByRole("link", { name: "Read the chronicle of Fresh Hero" }).waitFor();

  // Older shared ledger links land on the run's page with the story open.
  await page.goto(new URL("/dashboard?run=" + told + "&view=chronicle", url).href);
  await page.waitForURL((u) => u.pathname === "/replays/" + told && u.searchParams.get("view") === "chronicle");
  await page.waitForSelector("#chronicle-section .chronicle:not(.chronicle-draft)");
  assert.equal(await page.locator("#chronicle-section .chronicle-title").textContent(), "Tale Told Already");
  await page.goto(new URL("/dashboard?run=" + told, url).href);
  await page.waitForURL((u) => u.pathname === "/replays/" + told && !u.searchParams.has("view"));
  assert.equal(calls.length, 2, "views never regenerate");

  // The replay page leads with the chronicle and can tell a new one inline.
  const third = "chronicleRun0008";
  await seed(store, third, await recordArchive(third, "Page Hero"), { name: "Page Hero" });
  await fetch(new URL("/api/runs", url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runs: [
    { id: third, name: "Page Hero", role: "valkyrie", turn: 5, ended: true, endKind: "death", maxDepth: 3, maxLevel: 2 },
  ] }) });
  await page.goto(new URL("/replays/" + told, url).href);
  await page.waitForSelector("#chronicle-section:not([hidden]) .chronicle:not(.chronicle-draft)");
  assert.equal(await page.locator("#chronicle-section .chronicle-title").textContent(), "Tale Told Already");
  assert.ok(await page.locator("#chronicle-section #tell-tale").isHidden(), "an existing tale is shown, not offered again");
  assert.equal(await page.evaluate(() => new URL(location.href).searchParams.get("view")), "chronicle", "the story is the page's route");
  assert.ok((await page.evaluate(() => document.querySelector("#chronicle-section").getBoundingClientRect().top < document.querySelector("#replay").getBoundingClientRect().top)), "the story sits above the player");
  await page.goto(new URL("/replays/" + third, url).href);
  await page.waitForSelector("#chronicle-section:not([hidden]) #tell-tale:not([hidden])");
  assert.equal(await page.evaluate(() => location.search), "", "an untold tale is offered without claiming the route");
  await page.locator("#chronicle-section #tell-tale").click();
  await page.waitForSelector("#chronicle-section .chronicle-draft");
  await page.waitForSelector("#chronicle-section .chronicle:not(.chronicle-draft)", { timeout: 60000 });
  assert.equal(calls.length, 3, "the replay page asked the chronicler once");
  assert.equal(await page.locator("#chronicle-section .chronicle-title").textContent(), "Tale Page Hero");
  await page.goto(new URL("/replays/" + third + "?view=chronicle", url).href);
  await page.waitForSelector("#chronicle-section .chronicle:not(.chronicle-draft)");
  assert.equal(calls.length, 3, "the shared story link reads the stored tale");
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

test("a watcher receives replay progress, the story as it is written and the stored document; a watcher who leaves does not stop the work", { timeout: 120000 }, async (t) => {
  const store = new MemoryStorage(), calls = [];
  const model = async (digest, { onDelta }) => {
    calls.push(digest);
    const text = markdownTale(digest, "Streamed " + digest.hero.name);
    let sent = "";
    for (const piece of text.match(/.{1,24}/gs)) {
      await new Promise((r) => setTimeout(r, 15));
      sent += piece;
      onDelta(piece, sent);
    }
    return { raw: text, usage: { total_tokens: 7 } };
  };
  const server = createTestHarness({ store, wrap: (fn) => storyModelContext.run(model, fn) });
  const { url } = await server.listen();
  t.after(() => server.close());
  const watched = "chronicleRun0010", abandoned = "chronicleRun0011";
  for (const [id, name] of [[watched, "Watched"], [abandoned, "Abandoned"]]) await seed(store, id, await recordArchive(id, name), { name });
  await fetch(new URL("/api/runs", url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runs: [
    { id: watched, name: "Watched", role: "valkyrie", turn: 5, ended: true, endKind: "death", maxDepth: 4, maxLevel: 3 },
    { id: abandoned, name: "Abandoned", role: "valkyrie", turn: 5, ended: true, endKind: "death", maxDepth: 4, maxLevel: 3 },
  ] }) });
  const post = (id) => fetch(new URL("/api/runs/" + id + "/chronicle", url), { method: "POST", headers: { accept: "application/x-ndjson" } });

  let r = await post(watched);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /application\/x-ndjson/);
  const events = await readLines(r);
  const kinds = events.map((e) => e.delta !== undefined ? "delta" : e.available !== undefined ? "final" : e.status);
  assert.equal(kinds[0], "replaying");
  assert.ok(kinds.indexOf("writing") > kinds.lastIndexOf("replaying"), "the model starts after the replay");
  assert.ok(kinds.filter((k) => k === "delta").length >= 3, "the story arrives in pieces");
  assert.ok(kinds.indexOf("storing") > kinds.lastIndexOf("delta"));
  assert.equal(kinds.at(-1), "final");
  const deltas = events.filter((e) => e.delta !== undefined);
  assert.ok(deltas.at(-1).at - deltas[0].at >= 40, "pieces arrive over time, not in one buffered body");
  const replays = events.filter((e) => e.status === "replaying");
  assert.equal(replays.at(-1).done, replays.at(-1).total, "progress reaches the end of the archive");
  assert.ok(replays.at(-1).total >= 5);
  const text = events.filter((e) => e.delta !== undefined).map((e) => e.delta).join("");
  assert.ok(text.startsWith("# Streamed Watched"), "deltas are the model's markdown, in order");
  const final = events.at(-1);
  assert.equal(final.available, true);
  assert.equal(final.story.title, "Streamed Watched");
  assert.deepEqual(final.story.paragraphs.map((p) => p.sources.length), [1, 1]);
  assert.ok(final.story.paragraphs.every((p) => !/\[T\d/.test(p.text)), "citations are parsed out of the prose");
  assert.equal(calls.length, 1);

  r = await post(abandoned);
  const partial = await readLines(r, (seen) => seen.some((e) => e.delta !== undefined));
  assert.ok(partial.some((e) => e.delta !== undefined), "the reader left after the first words");
  for (let i = 0; i < 100 && !publicStoreFor(store).docs.has("chronicles/" + abandoned + "/story.json"); i++) await new Promise((res) => setTimeout(res, 50));
  const stored = publicStoreFor(store).docs.get("chronicles/" + abandoned + "/story.json");
  assert.ok(stored, "the job finished and stored the tale without its reader");
  assert.equal(stored.value.story.title, "Streamed Abandoned");
  assert.equal(calls.length, 2, "no second model call for the abandoned reader");
  r = await fetch(new URL("/api/runs/" + abandoned + "/chronicle", url));
  assert.equal(r.status, 200);
  const stats = await (await fetch(new URL("/api/stats", url))).json();
  assert.equal(stats.best.find((x) => x.id === abandoned).chronicleAvailable, true);

  const plain = await fetch(new URL("/api/runs/chronicleRun0012/chronicle", url), { method: "POST", headers: { accept: "application/x-ndjson" } });
  assert.equal(plain.status, 409, "refusals stay ordinary JSON responses even for stream readers");
});
