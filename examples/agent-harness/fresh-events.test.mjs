import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestCompletedPair, freshEyeBumpEvidence } from './fresh-events.mjs';

// Disposable public-shape fixtures; no archived sessions or recordings.
const bump = 'You move right into the floating eye.';
function fixture() {
  const request = { version: 1, method: 'game.moveWithoutAttack', params: {
    sessionId: 'fixture-session', requestId: 'step-1', expectedRevision: 6, direction: 'east',
  } };
  const response = {
    version: 1, sessionId: 'fixture-session', requestId: 'step-1', revision: 7,
    outcome: { action: 'moveWithoutAttack', status: 'completed', turnsElapsed: 1, positionChanged: false, effects: [] },
    observation: { you: { x: 10, y: 10 }, heard: [bump], turn: 30 },
    events: [{ type: 'heard', text: bump }], decision: null, ended: false, end: null,
  };
  return { records: [{ request, response }], snapshot: { sessionId: 'fixture-session', revision: 7 } };
}
function mcp(f = fixture(), name = "moveWithoutAttack") {
  const { request, response } = f.records[0];
  const { sessionId, direction } = request.params;
  f.records = [
    { direction: 'request', message: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { sessionId, direction } } } },
    { direction: 'response', message: { jsonrpc: '2.0', id: 1, result: { isError: false, structuredContent: response } } },
  ];
  return f;
}
const frame = f => f.records[0].response;

test('genuine action-local bump retains exact public evidence and does not mutate inputs', () => {
  const f = fixture(), before = structuredClone(f);
  const result = freshEyeBumpEvidence(f);
  assert.deepEqual(result, { kind: 'fresh-eye-bump', reason: 'action-local-heard', evidence: {
    sessionId: 'fixture-session', revision: 7, requestId: 'step-1', method: 'game.moveWithoutAttack',
    action: 'moveWithoutAttack', status: 'completed', turnsElapsed: 1, text: bump, source: 'events.heard',
  } });
  assert.deepEqual(f, before);
});

test('old rolling eye text without a fresh heard event is never a bump', () => {
  const f = fixture(); frame(f).events = [];
  assert.equal(freshEyeBumpEvidence(f).reason, 'no-action-local-bump');
});

test('a newer completed query supersedes a real bump at the same revision', () => {
  const f = mcp();
  const request = structuredClone(f.records[0]); request.message.id = 2;
  request.message.params.name = "syncState";
  const response = structuredClone(f.records[1]); response.message.id = 2;
  Object.assign(response.message.result.structuredContent.outcome, { action: 'observe', turnsElapsed: 0 });
  response.message.result.structuredContent.events = [];
  f.records.push(request, response);
  assert.equal(latestCompletedPair(f.records).request.id, 2);
  assert.equal(freshEyeBumpEvidence(f).reason, 'unrelated-operation');
});

test('unrelated stationary action and zero-turn query cannot borrow eye evidence', () => {
  for (const [method, action, turns] of [['game.search', 'search', 1], ['session.observe', 'observe', 0], ['session.receipt', 'moveWithoutAttack', 1]]) {
    const f = fixture(); f.records[0].request.method = method;
    Object.assign(frame(f).outcome, { action, turnsElapsed: turns });
    assert.equal(freshEyeBumpEvidence(f).reason, 'unrelated-operation');
  }
});

test('witnessed zero-turn movement is evidence, while malformed costs are rejected', () => {
  for (const status of ['completed', 'blocked']) {
    const f = fixture(); Object.assign(frame(f).outcome, { status, turnsElapsed: 0 });
    assert.equal(freshEyeBumpEvidence(f).evidence.turnsElapsed, 0);
  }
  for (const turnsElapsed of [-1, 0.5, NaN, Infinity, undefined, '1']) {
    const f = fixture(); frame(f).outcome.turnsElapsed = turnsElapsed;
    assert.equal(freshEyeBumpEvidence(f).reason, 'unwitnessed-outcome');
  }
});

test('latest error or uncertain call never falls back to an earlier successful bump', () => {
  for (const response of [{ error: { code: 'staleRevision' } }, null]) {
    const f = fixture(); f.records.push({ request: structuredClone(f.records[0].request), response });
    assert.equal(freshEyeBumpEvidence(f).evidence, null);
  }
  const f = mcp();
  f.records.push({ direction: 'request', message: { ...f.records[0].message, id: 2 } },
    { direction: 'response', message: { id: 2, error: { code: -32603 } } });
  assert.equal(freshEyeBumpEvidence(f).reason, 'latest-response-error');
});

test('same session, current revision and exact low request receipt are mandatory', () => {
  for (const mutate of [
    f => { f.snapshot.sessionId = 'other'; },
    f => { frame(f).sessionId = 'other'; },
    f => { f.records[0].request.params.sessionId = 'other'; },
    f => { f.snapshot.revision++; },
    f => { frame(f).revision--; },
    f => { frame(f).requestId = 'other'; },
    f => { f.records[0].request.params.expectedRevision = 7; },
    f => { delete f.records[0].request.params.expectedRevision; },
    f => { frame(f).historical = true; },
  ]) {
    const f = fixture(); mutate(f);
    assert.equal(freshEyeBumpEvidence(f).evidence, null);
  }
});

test('wrong status, actual movement and unrelated outcome do not establish a refused step', () => {
  for (const patch of [
    ...['needsChoice', 'cancelled', 'interrupted', 'unknown', undefined].map(status => ({ status })),
    { positionChanged: true }, { positionChanged: undefined }, { action: 'search' },
  ]) {
    const f = fixture(); Object.assign(frame(f).outcome, patch);
    assert.equal(freshEyeBumpEvidence(f).evidence, null);
  }
});

test('only the exact witnessed heard message counts, not lore or mention of an eye', () => {
  for (const event of [
    { type: 'passage', text: bump }, { type: 'heard', text: bump, textWindow: true },
    { type: 'heard', text: 'You see a floating eye.' },
    { type: 'heard', text: `Previously: ${bump}` }, { type: 'heard', text: 'You do not move right into the floating eye.' },
  ]) {
    const f = fixture(); frame(f).events = [event];
    assert.equal(freshEyeBumpEvidence(f).reason, 'no-action-local-bump');
  }
});

test('MCP pairs match outer IDs and preserve call identity without invented input revisions', () => {
  const f = mcp();
  assert.equal(latestCompletedPair(f.records).request.params.name, "moveWithoutAttack");
  assert.equal(freshEyeBumpEvidence(f).evidence.callId, 1);
  f.records[1].message.id = '1';
  assert.equal(latestCompletedPair(f.records), null);
});

const initialized = () => ({ direction: 'request', message: {
  jsonrpc: '2.0', method: 'notifications/initialized',
} });

test('MCP initialization notification does not hide a later genuine bump or become a call', () => {
  for (const params of [undefined, {}, { _meta: { trace: 'fixture' } }]) {
    const f = mcp(), notification = initialized();
    if (params !== undefined) notification.message.params = params;
    f.records.unshift(
      { direction: 'request', message: { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} } },
      { direction: 'response', message: { jsonrpc: '2.0', id: 0, result: { protocolVersion: 'fixture' } } },
      notification,
    );
    assert.equal(latestCompletedPair(f.records).request.id, 1);
    assert.equal(freshEyeBumpEvidence(f).kind, 'fresh-eye-bump');
  }
  assert.equal(latestCompletedPair([initialized()]), null);
});

test('known notification never clears pending input or an error', () => {
  const f = mcp();
  f.records.push({ direction: 'request', message: { ...f.records[0].message, id: 2 } }, initialized());
  assert.equal(latestCompletedPair(f.records), null);
  f.records.push({ direction: 'response', message: { jsonrpc: '2.0', id: 2, error: { code: -32603 } } }, initialized());
  assert.equal(freshEyeBumpEvidence(f).reason, 'latest-response-error');
});

test('arbitrary, malformed and uncertainty-bearing notification records remain rejected', () => {
  for (const mutate of [
    row => { row.message.method = 'notifications/cancelled'; },
    row => { row.message.id = null; },
    row => { row.message.id = 2; },
    row => { row.message.jsonrpc = '1.0'; },
    row => { row.direction = 'response'; },
    row => { row.message.error = { code: -32603 }; },
    row => { row.message.result = {}; },
    row => { row.message.params = null; },
    row => { row.message.params = { unexpected: true }; },
    row => { row.message.params = { _meta: null }; },
    row => { row.result = 'transportUncertain'; },
  ]) {
    const f = mcp(), row = initialized(); mutate(row); f.records.unshift(row);
    assert.equal(latestCompletedPair(f.records), null);
    assert.equal(freshEyeBumpEvidence(f).evidence, null);
  }
});

test('pending, duplicate and orphan MCP records fail closed, including a later query', () => {
  for (const change of [
    f => { f.records.push({ direction: 'request', message: { ...f.records[0].message, id: 2 } }); },
    f => { f.records.push(...structuredClone(f.records)); },
    f => { f.records.shift(); },
    f => { f.records.splice(1, 0, { direction: 'request', message: { ...f.records[0].message, id: 2 } }); },
    f => { f.records[1].message.result.isError = true; },
    f => { f.records[0].message.params.name = "syncState"; },
  ]) {
    const f = mcp(); change(f); assert.equal(freshEyeBumpEvidence(f).evidence, null);
  }
  assert.equal(latestCompletedPair([]), null);
  assert.equal(freshEyeBumpEvidence().evidence, null);
});

test('single-action go requires an actual move outcome; navigation aggregates are unsupported', () => {
  const f = fixture(); frame(f).outcome.action = 'move'; frame(f).navigation = { actionsTaken: 1 };
  mcp(f, 'go');
  assert.equal(freshEyeBumpEvidence(f).kind, 'fresh-eye-bump');
  f.records[1].message.result.structuredContent.navigation.actionsTaken = 2;
  assert.equal(freshEyeBumpEvidence(f).reason, 'navigation-not-single-action');
});

test('unknown adjacent occupant remains uncertainty and is never labelled an eye', () => {
  const f = fixture(); frame(f).events = [];
  frame(f).observation.world = [{ x: 11, y: 10, occupant: { kind: 'creature' } }];
  const before = structuredClone(frame(f).observation.world);
  assert.deepEqual(freshEyeBumpEvidence(f), { kind: 'no-fresh-eye-bump', reason: 'no-action-local-bump', evidence: null });
  assert.deepEqual(frame(f).observation.world, before);
});
