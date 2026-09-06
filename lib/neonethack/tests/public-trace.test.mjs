import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { PublicTrace } from '../dist/typescript/public-trace.js';
const identity = { runId: 'life-one', processId: 'process-one', codeVersion: 'sample-revision', runtime: { backend: 'wasm', packageId: 'actual-package-digest', libraryVersion: '1.0.0', runtimeProfile: 1 } };
const request = () => ({ version: 1, method: 'game.search', params: { sessionId: 'session-one', requestId: 'immutable-one', expectedRevision: 2 } });
const response = () => ({ version: 1, sessionId: 'session-one', requestId: 'immutable-one', revision: 3, observation: { turn: 9 }, outcome: { action: 'search', status: 'completed', turnsElapsed: 1, effects: [] }, events: [{ type: 'heard', text: 'You search.' }], ended: false, end: null });
const records = trace => trace.export().chunks.map(c => JSON.parse(gunzipSync(c.bytes).toString()));
test('compressed public trace preserves full immutable pairs, actual package and separate process/run/code identities', async () => {
  const trace = new PublicTrace(identity); let release;
  const pending = new Promise(resolve => { release = resolve; });
  const payload = request(), original = structuredClone(payload), result = response();
  const transport = trace.wrap({ close: async () => {}, async send(exact) { assert.ok(Object.isFrozen(exact.params)); await pending; return result; } });
  const call = transport.send(payload); payload.params.requestId = 'caller-mutated';
  assert.throws(() => trace.export(), /settle/); release(); await call;
  result.events[0].text = 'caller-mutated-response';
  const [entry] = records(trace);
  assert.deepEqual(entry.request, original); assert.equal(entry.response.events[0].text, 'You search.');
  assert.equal(entry.runtime.packageId, identity.runtime.packageId); assert.equal(entry.codeVersion, identity.codeVersion);
  assert.equal(entry.runId, 'life-one'); assert.equal(entry.processId, 'process-one');
  assert.equal(entry.turn, 9); assert.equal(entry.revision, 3); assert.equal(entry.sequence, 1);
  assert.equal(trace.export().manifest.replayable, false); assert.equal(trace.export().manifest.complete, false);
  const exported = trace.export(); exported.chunks[0].bytes.fill(0); assert.equal(records(trace).length, 1);
});
test('vault URLs, credential keys and recognizable bearer secrets are redacted and exports are never replay input', async () => {
  const trace = new PublicTrace({ ...identity, runId: 'https://vault.invalid/?key=private' });
  const result = { ...response(), storage: { status: 'ok', replicaUrl: 'https://vault.invalid/secret', apiKey: 'private', credentials: { password: 'private' } } };
  result.events.push({ type: 'heard', text: 'Bearer secret-value https://vault.invalid/#private' });
  await trace.wrap({ close: async () => {}, send: async () => result }).send(request());
  const text = JSON.stringify(records(trace)); assert.ok(!text.includes('secret-value')); assert.ok(!text.includes('vault.invalid')); assert.ok(!text.includes('"private"'));
  assert.equal(trace.export().manifest.exactPublicPairs, false); assert.ok(trace.export().manifest.redactions >= 4);
});
test('lost reply records original request and uncertainty without exception secrets or an automatic retry', async () => {
  const trace = new PublicTrace(identity); let calls = 0;
  const wrapped = trace.wrap({ close: async () => {}, send: async () => { calls++; throw Error('private unrecognized credential'); } });
  await assert.rejects(wrapped.send(request()), /private/);
  const [entry] = records(trace); assert.deepEqual(entry.request, request()); assert.equal(entry.response, null);
  assert.equal(entry.result, 'transportUncertain'); assert.equal(calls, 1);
  assert.ok(!JSON.stringify(entry).includes('unrecognized credential'));
});
test('bounded records, raw chunk size and compressed total stop tracing without altering successful input', async () => {
  for (const options of [{ maxRecords: 1 }, { maxChunkBytes: 10 }, { maxTotalBytes: 10 }]) {
    const trace = new PublicTrace(identity, options), result = response(); let calls = 0;
    const wrapped = trace.wrap({ close: async () => {}, send: async () => { calls++; return result; } });
    assert.equal(await wrapped.send(request()), result); assert.equal(await wrapped.send(request()), result);
    assert.equal(calls, 2); assert.ok(trace.status.stopped); assert.ok(trace.status.records <= 1);
    assert.ok(trace.status.compressedBytes <= (options.maxTotalBytes ?? Infinity));
  }
});
test('compression failure is a recording stop, never a transport uncertainty', async () => {
  const original = globalThis.CompressionStream;
  try {
    globalThis.CompressionStream = class { constructor() { throw Error('compression unavailable'); } };
    const trace = new PublicTrace(identity), result = response();
    const wrapped = trace.wrap({ close: async () => {}, send: async () => result });
    assert.equal(await wrapped.send(request()), result); assert.equal(trace.status.stopped, 'recording failure');
  } finally { globalThis.CompressionStream = original; }
});

test('invalid pre-submission clone and cyclic inputs leave recorder usable and create no uncertain entry', async () => {
  for (const kind of ['function', 'cycle']) {
    const trace = new PublicTrace(identity); let calls = 0;
    const wrapped = trace.wrap({ close: async () => {}, send: async () => { calls++; return response(); } });
    const malformed = request();
    if (kind === 'function') malformed.params.extra = () => {};
    else malformed.params.extra = malformed;
    await assert.rejects(wrapped.send(malformed), kind === 'cycle' ? /cyclic.*before submission/i : /clone/i);
    assert.equal(calls, 0);
    assert.equal(trace.export().manifest.records, 0, 'rejected input is not transport uncertainty');
    assert.equal(trace.status.stopped, null);
    await wrapped.send(request());
    assert.equal(calls, 1);
    assert.equal(trace.export().manifest.records, 1);
    assert.equal(records(trace)[0].result, 'response');
  }
});
