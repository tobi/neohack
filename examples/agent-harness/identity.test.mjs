import assert from 'node:assert/strict';
import test from 'node:test';
import { GuardIdentityError, parseGuardArgs, validateGuardIdentity, loadGuardSnapshot } from './identity.mjs';

const args = (run = 'run016', session = 'hero016', rev = '9') =>
  [run, 'attack', '11', '10', '--session-id', session, '--revision', rev];
const request = () => parseGuardArgs(args());
// Disposable public-response fixtures. Only the downstream test policy reads
// the witnessed occupant; identity validation never interprets monsters.
function fixture(runId = 'run016', sessionId = 'hero016', revision = 9, appearance = 'floating eye') {
  const snapshot = { version: 1, sessionId, revision, requestId: null,
    outcome: { action: 'observe', status: 'completed', turnsElapsed: 0, positionChanged: false, effects: [] },
    observation: { turn: 10, location: { id: 'level-1-1', depthLabel: 'Dlvl:1' }, you: { x: 10, y: 10 },
      vitals: {}, inventory: [], inventoryKnown: true, here: { known: true, items: [] },
      perception: { version: 1, inventory: 'current', here: 'current', equipment: 'current' },
      world: [{ x: 11, y: 10, visible: true, terrain: { type: 'room', knowledge: 'remembered' },
        ...(appearance ? { occupant: { kind: 'creature', mark: 'e', appearance } } : {}) }], heard: [] },
    events: [], decision: null, ended: false, end: null };
  return { envelope: { runId, snapshot }, current: { runId, sessionId, revision, ended: false, end: null } };
}
const hasCode = code => error => error instanceof GuardIdentityError && error.code === code;

test('requires explicit run, operation, target, session and revision', () => {
  assert.deepEqual(request(), { runId: 'run016', operation: 'attack', target: { x: 11, y: 10 },
    expectedSessionId: 'hero016', expectedRevision: 9 });
  const kick = args(); kick[1] = 'kick';
  assert.equal(parseGuardArgs(kick).operation, 'kick');
  for (const argv of [[], ['attack', '11', '10'], ['run016', '11', '10'],
    args().slice(0, 4), args().slice(0, 6), [...args(), 'extra'], [...args(), '--session-id', 'hero015'],
    [...args(), '--revision', '8'], [...args(), '--typo', 'yes']]) {
    assert.throws(() => parseGuardArgs(argv), GuardIdentityError);
  }
});

test('rejects historical broken invocation and typo operations', () => {
  for (const operation of ['run016', 'attak', 'report', '', 'ATTACK']) {
    const argv = args(); argv[1] = operation;
    assert.throws(() => parseGuardArgs(argv), hasCode('invalid_operation'));
  }
  assert.throws(() => parseGuardArgs(['run016', '64', '9']), hasCode('invalid_arguments'));
});

test('session identity is opaque and may contain punctuation', () => {
  const sessionId = 'session:hero/16+opaque=value.with.punctuation';
  const expected = parseGuardArgs(args('run016', sessionId));
  const { envelope, current } = fixture('run016', sessionId);
  assert.equal(validateGuardIdentity(expected, envelope, current), envelope.snapshot);
  assert.throws(() => parseGuardArgs(args('run016', '')), hasCode('invalid_request'));
});

test('rejects ambiguous numeric values and path-like run tokens', () => {
  for (const value of ['-1', '1.2', '1e2', '0x10', '', 'NaN', '9007199254740992']) {
    const argv = args(); argv[2] = value;
    assert.throws(() => parseGuardArgs(argv), GuardIdentityError);
    assert.throws(() => parseGuardArgs(args('run016', 'hero016', value)), GuardIdentityError);
  }
  for (const run of ['../run015', '/tmp/run015', '', 'run 015']) {
    assert.throws(() => parseGuardArgs(args(run)), hasCode('invalid_request'));
  }
  assert.equal(parseGuardArgs(args('run016', 'hero016', '0')).expectedRevision, 0);
});

test('two conflicting runs: reads only requested run and passes its threats to policy', async () => {
  const runs = new Map([
    ['run015', fixture('run015', 'hero015', 9, null)], ['run016', fixture()],
  ]);
  const reads = [];
  const readers = {
    readSnapshot: async run => { reads.push(['snapshot', run]); return runs.get(run)?.envelope; },
    readCurrentIdentity: async run => { reads.push(['current', run]); return runs.get(run)?.current; },
  };
  const snapshot = await loadGuardSnapshot(request(), readers);
  assert.deepEqual(reads, [['snapshot', 'run016'], ['current', 'run016']]);
  assert.equal(snapshot.observation.world[0].occupant.appearance, 'floating eye');
  const clear = await loadGuardSnapshot(parseGuardArgs(args('run015', 'hero015')), readers);
  assert.equal(clear.observation.world[0].occupant, undefined);
  await assert.rejects(loadGuardSnapshot(request(), {
    ...readers, readSnapshot: async () => runs.get('run015').envelope,
  }), hasCode('run_mismatch'));
});

test('rejects missing snapshot, missing current identity and reader failures', async () => {
  const { envelope, current } = fixture();
  for (const missing of [undefined, null, {}, { runId: 'run016' }]) {
    assert.throws(() => validateGuardIdentity(request(), missing, current), hasCode('missing_snapshot'));
  }
  assert.throws(() => validateGuardIdentity(request(), envelope, null), hasCode('missing_identity'));
  await assert.rejects(loadGuardSnapshot(request()), hasCode('missing_reader'));
  const failure = new Error('snapshot not found');
  await assert.rejects(loadGuardSnapshot(request(), {
    readSnapshot: async () => { throw failure; }, readCurrentIdentity: async () => current,
  }), error => error === failure);
});

test('validates identity on both snapshot and current owner, including stale cached pairs', () => {
  for (const [field, value, code] of [
    ['runId', 'run015', 'run_mismatch'], ['sessionId', 'hero015', 'session_mismatch'],
    ['revision', 8, 'stale_revision'], ['revision', 10, 'stale_revision'], ['revision', undefined, 'missing_identity'],
  ]) {
    const { envelope, current } = fixture();
    assert.throws(() => validateGuardIdentity(request(), envelope, { ...current, [field]: value }), hasCode(code));
    if (field === 'runId') envelope.runId = value;
    else envelope.snapshot[field] = value;
    assert.throws(() => validateGuardIdentity(request(), envelope, current), hasCode(code));
  }
});

test('terminal old run cannot pass even with apparently live perceived surroundings', () => {
  for (const state of [{ ended: true, end: { kind: 'death', turn: 10 } },
    { ended: false, end: { kind: 'quit', turn: 10 } }, { ended: undefined }, { end: undefined }]) {
    const { envelope, current } = fixture('run015', 'hero015', 9, null);
    const oldRequest = parseGuardArgs(args('run015', 'hero015'));
    assert.throws(() => validateGuardIdentity(oldRequest, envelope, { ...current, ...state }), hasCode('inactive_state'));
    Object.assign(envelope.snapshot, state);
    assert.throws(() => validateGuardIdentity(oldRequest, envelope, current), hasCode('inactive_state'));
  }
});

test('context rotation keeps same hero valid but cannot reuse binding for a new hero', () => {
  const before = fixture();
  const rotated = structuredClone(before);
  assert.equal(validateGuardIdentity(request(), rotated.envelope, rotated.current), rotated.envelope.snapshot);
  // Same run label and revision are insufficient when a new session starts.
  const replacement = fixture('run016', 'new-hero', 9, null);
  assert.throws(() => validateGuardIdentity(request(), replacement.envelope, replacement.current), hasCode('session_mismatch'));
  const newRequest = parseGuardArgs(args('run016', 'new-hero'));
  assert.throws(() => validateGuardIdentity(newRequest, before.envelope, replacement.current), hasCode('session_mismatch'));
  assert.equal(validateGuardIdentity(newRequest, replacement.envelope, replacement.current), replacement.envelope.snapshot);
});

test('current identity is checked after loading and caller mutation cannot retarget the check', async () => {
  const original = fixture();
  const changed = { ...original.current, revision: 10 };
  const pending = request();
  await assert.rejects(loadGuardSnapshot(pending, {
    readSnapshot: async () => { pending.expectedRevision = 10; return original.envelope; },
    readCurrentIdentity: async () => changed,
  }), hasCode('stale_revision'));
});

test('refuses unresolved decisions, deltas, historical/error/unknown responses and absent observation', () => {
  for (const [patch, code] of [
    [{ decision: { id: 'choice-1', kind: 'confirmation' } }, 'standing_decision'],
    [{ decision: undefined }, 'standing_decision'], [{ update: { kind: 'delta' } }, 'invalid_snapshot'],
    [{ historical: true }, 'uncertain_snapshot'], [{ error: { code: 'stale_revision' } }, 'uncertain_snapshot'],
    [{ outcome: { status: 'unknown' } }, 'uncertain_snapshot'], [{ observation: null }, 'invalid_snapshot'],
    [{ version: 2 }, 'invalid_snapshot'],
  ]) {
    const { envelope, current } = fixture();
    Object.assign(envelope.snapshot, patch);
    assert.throws(() => validateGuardIdentity(request(), envelope, current), hasCode(code));
  }
});

test('programmatic entry validates request before calling any reader', async () => {
  let calls = 0;
  await assert.rejects(loadGuardSnapshot({ ...request(), expectedRevision: '9' }, {
    readSnapshot: () => { calls++; }, readCurrentIdentity: () => { calls++; },
  }), hasCode('invalid_request'));
  assert.equal(calls, 0);
});
