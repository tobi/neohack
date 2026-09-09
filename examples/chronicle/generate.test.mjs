import "./no-model-calls.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChronicleDigest } from "./digest.mjs";
import { MODEL, SYSTEM, transcript } from "./prompt.mjs";
import { GATEWAY_URL, MAX_OUTPUT_TOKENS, chronicleDocument, evidenceHash, gatewayStory, parseStory } from "./generate.mjs";

// Synthetic replies: a labelled test fixture, not a claim about NetHack events.
function digest() {
  const c = new ChronicleDigest({ name: "Double", role: "valkyrie" });
  const reply = (i, extra = {}) => ({
    version: 1,
    sessionId: "double-test",
    revision: i,
    observation: { turn: i + 1, heard: extra.heard ?? [], vitals: {}, world: [], location: { depthLabel: "Dlvl:1" } },
    events: [],
    ended: !!extra.end,
    end: extra.end ?? null,
    ...(extra.outcome ? { outcome: extra.outcome } : {}),
  });
  c.add(reply(0));
  c.add(reply(1, { heard: ["You see here a little dog."], outcome: { action: "pray", status: "completed" } }));
  c.add(reply(2, { end: { kind: "quit", turn: 3 } }));
  return c.finish();
}
const story = (d) => ({
  title: "A Test Double",
  paragraphs: [
    { text: "Double arrived with a little dog.", sources: [d.events[0].id] },
    { text: "Then the attempt ended.", sources: [d.events.at(-1).id] },
  ],
});
const markdown = (d) => `# A Test Double\n\nDouble arrived with a little dog. [${d.events[0].id}]\n\nThen the attempt ended. [${d.events.at(-1).id}]\n`;
const sse = (chunks, usage) =>
  new Response(
    [
      ...chunks.map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`),
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
const okResponse = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

test("gatewayStory sends one bounded request with the caller's token and never retries a failure", async () => {
  const d = digest(), requests = [];
  const fetchDouble = async (url, init) => {
    requests.push({ url, init });
    return okResponse({ choices: [{ message: { content: markdown(d) }, finish_reason: "stop" }], usage: { total_tokens: 10 } });
  };
  const result = await gatewayStory(d, { token: "test-only-token", fetch: fetchDouble });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, GATEWAY_URL);
  assert.equal(requests[0].init.headers.authorization, "Bearer test-only-token");
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.model, MODEL);
  assert.equal(body.max_tokens, MAX_OUTPUT_TOKENS);
  assert.deepEqual(body.messages.map((m) => m.role), ["system", "user"]);
  assert.equal(body.messages[0].content, SYSTEM);
  assert.equal(body.messages[1].content, transcript(d), "the user message is exactly the markdown journal");
  assert.equal(body.stream, undefined, "without a delta listener the reply is one document");
  assert.ok(body.messages[1].content.includes(d.events.at(-1).id + " Dlvl:1 · ENDING quit"), "turn lines carry ids, place and the ending");
  assert.ok(!requests[0].init.body.includes("test-only-token"), "the credential never enters the prompt");
  const parsed = parseStory(result.raw, d);
  assert.equal(parsed.title, "A Test Double");
  assert.deepEqual(result.usage, { total_tokens: 10 });

  await assert.rejects(gatewayStory(d, { fetch: fetchDouble }), /no credential/);
  assert.equal(requests.length, 1, "a missing credential makes no request");

  let attempts = 0;
  const failing = async () => { attempts++; return new Response("overloaded", { status: 503 }); };
  await assert.rejects(gatewayStory(d, { token: "t", fetch: failing }), (error) => /503/.test(error.message) && error.status === 503);
  assert.equal(attempts, 1, "failures are reported, not retried");

  const truncated = async () => okResponse({ choices: [{ message: { content: "{" }, finish_reason: "length" }] });
  await assert.rejects(gatewayStory(d, { token: "t", fetch: truncated }), /output limit/);
});

test("gatewayStory streams deltas in order when a listener is supplied and still returns the whole text", async () => {
  const d = digest(), text = markdown(d), pieces = [];
  let body;
  const fetchDouble = async (_url, init) => {
    body = JSON.parse(init.body);
    return sse([text.slice(0, 12), text.slice(12, 40), text.slice(40)], { total_tokens: 42 });
  };
  const result = await gatewayStory(d, { token: "t", fetch: fetchDouble, onDelta: (delta, soFar) => pieces.push([delta, soFar]) });
  assert.equal(body.stream, true);
  assert.deepEqual(pieces.map(([delta]) => delta), [text.slice(0, 12), text.slice(12, 40), text.slice(40)]);
  assert.equal(pieces.at(-1)[1], text, "the listener also sees the accumulated text");
  assert.equal(result.raw, text);
  assert.deepEqual(result.usage, { total_tokens: 42 });
  assert.equal(parseStory(result.raw, d).paragraphs.length, 2);

  const cut = async () => sse(["# Title\n\nUnfinished"], undefined).text().then((t) => new Response(t.replace('"finish_reason":"stop"', '"finish_reason":"length"'), { status: 200 }));
  await assert.rejects(gatewayStory(d, { token: "t", fetch: cut, onDelta() {} }), /output limit/);
});

test("parseStory accepts the markdown shape (fenced or bare) and legacy JSON, and rejects uncited stories", () => {
  const d = digest();
  const parsed = parseStory(markdown(d), d);
  assert.equal(parsed.title, "A Test Double");
  assert.deepEqual(parsed.paragraphs[0], { text: "Double arrived with a little dog.", sources: [d.events[0].id] });
  assert.equal(parseStory("```markdown\n" + markdown(d) + "```", d).title, "A Test Double");
  assert.equal(parseStory(JSON.stringify(story(d)), d).title, "A Test Double");
  assert.throws(() => parseStory("{not json", d), /invalid JSON/);
  assert.throws(() => parseStory("no heading and no citations", d), /one-page story/);
  assert.throws(() => parseStory(undefined, d), /no story text/);
  assert.throws(() => parseStory(markdown(d).replace(`[${d.events.at(-1).id}]`, "[T999]"), d), /source/);
});

test("chronicleDocument is deterministic for the same evidence and annotates only glossary names", () => {
  const d = digest();
  const glossary = { "little dog": { name: "little dog", lines: ["A small, loyal dog."] }, kobold: { name: "kobold", lines: ["Never mentioned in this story."] } };
  const doc = chronicleDocument({ digest: d, story: story(d), glossary, usage: { total_tokens: 10 }, generatedAt: 1 });
  assert.equal(doc.evidenceHash, evidenceHash(d));
  assert.equal(doc.model, MODEL);
  assert.deepEqual(Object.keys(doc.glossary), ["little dog"], "unused lore is dropped");
  assert.deepEqual(doc.story.paragraphs[0].segments, [
    { text: "Double arrived with a " },
    { text: "little dog", term: "little dog" },
    { text: "." },
  ]);
  assert.ok(!/Bearer|test-only/.test(JSON.stringify(doc)), "no credential material in the artifact");
});

test("the guard blocks any real gateway request from a test", async () => {
  await assert.rejects(async () => fetch(GATEWAY_URL, { method: "POST" }), /real model request/);
  assert.equal(process.env.AI_GATEWAY_API_KEY, undefined);
  assert.equal(process.env.VERCEL_OIDC_TOKEN, undefined);
});
