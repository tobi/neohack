import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDispatcher, DispatchError } from './dispatcher.mjs';

const initialState = () => ({
  sessionId: 'session-a', status: 'current', revision: 4, pendingRequest: null,
  snapshot: { version: 1, sessionId: 'session-a', revision: 4, ended: false, end: null,
    outcome: { status: 'completed' }, events: [], decision: null,
    observation: { turn: 12, location: { id: 'level-1' }, you: { x: 10, y: 10 } } },
});
const intent = (overrides = {}) => ({
  runId: 'run-a', sessionId: 'session-a', expectedRevision: 4,
  operation: 'attack', args: { target: { x: 11, y: 10 } }, approved: true,
  ...overrides,
});
const allow = ({ intent }) => ({
  status: 'OK', runId: intent.runId, sessionId: intent.sessionId,
  revision: intent.expectedRevision,
});
const validators = () => new Map([
  ['attack', args => Object.keys(args).join() === 'target'
    && Object.keys(args.target ?? {}).sort().join() === 'x,y'
    && Number.isInteger(args.target.x) && Number.isInteger(args.target.y)],
  ["answer", args => Object.keys(args).sort().join() === 'decisionId,value'
    && typeof args.decisionId === 'string' && typeof args.value === 'boolean'],
  ["cancel", args => Object.keys(args).join() === 'decisionId'
    && typeof args.decisionId === 'string'],
  ['go', args => Object.keys(args).sort().join() === 'maxActions,to'
    && Number.isInteger(args.to?.x) && Number.isInteger(args.to?.y)],
]);

// Disposable contract double, not an engine or replacement snapshot client.
// NEO-51 owns the real lock/reservations; supervisor tests their composition.
async function fixture(t, { guard = allow, state = initialState(), sendError } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'neo50-dispatch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'snapshot.json');
  await writeFile(path, JSON.stringify(state));
  const outbound = [], events = [];
  let tail = Promise.resolve();
  const client = {
    execute(call, { preflight }) {
      const result = tail.then(async () => {
        events.push('lock');
        try {
          const current = JSON.parse(await readFile(path, 'utf8'));
          events.push('read');
          await preflight(current);
          events.push('send');
          outbound.push(structuredClone(call));
          if (sendError) throw sendError;
          current.revision += 1;
          current.snapshot.revision += 1;
          await writeFile(path, JSON.stringify(current));
          events.push('persist');
          return { snapshot: current.snapshot, exactReceipt: 'fixture-receipt' };
        } finally {
          events.push('unlock');
        }
      });
      tail = result.catch(() => {});
      return result;
    },
  };
  const dispatch = createDispatcher({ runId: 'run-a', client, operations: validators(),
    guard: async context => { events.push('guard'); return guard(context); } });
  return { dispatch, outbound, events, path, dir };
}

async function blocked(f, input, code) {
  await assert.rejects(f.dispatch(input), error => {
    assert.ok(error instanceof DispatchError);
    if (code) assert.equal(error.code, code);
    assert.equal(error.sendAttempted, false);
    return true;
  });
  assert.equal(f.outbound.length, 0);
}

test('one explicit approved action sends once after guard, under lock through persistence', async t => {
  const f = await fixture(t);
  const result = await f.dispatch(intent());
  assert.deepEqual(f.outbound, [{ name: 'attack', arguments: {
    target: { x: 11, y: 10 }, sessionId: 'session-a', expectedRevision: 4,
  } }]);
  assert.equal(result.exactReceipt, 'fixture-receipt');
  assert.equal(result.snapshot.revision, 5);
  assert.deepEqual(f.events, ['lock', 'read', 'guard', 'send', 'persist', 'unlock']);
});

for (const result of [{ status: 'BLOCK' }, { status: 'ERROR' }, { status: 'UNKNOWN' },
  true, 'GUARD OK', null, undefined, { ok: true }]) {
  test(`guard result ${JSON.stringify(result)} sends nothing`, async t => {
    const f = await fixture(t, { guard: () => result });
    const before = await readFile(f.path, 'utf8');
    await blocked(f, intent(), 'GUARD_BLOCKED');
    assert.equal(await readFile(f.path, 'utf8'), before);
  });
}

test('guard crash preserves rejection and cause with zero sends', async t => {
  const crash = new TypeError('coordinate decoder crashed');
  const f = await fixture(t, { guard: () => { throw crash; } });
  await assert.rejects(f.dispatch(intent()), error => error.code === 'GUARD'
    && error.cause === crash && error.sendAttempted === false);
  assert.equal(f.outbound.length, 0);
});

test('missing guard dependency sends nothing', async t => {
  const f = await fixture(t, { guard: async () => {
    await readFile(join(f.dir, 'missing-guard-input.json'), 'utf8');
    return allow({ intent: intent() });
  } });
  await blocked(f, intent(), 'GUARD');
});

test('missing authoritative snapshot sends nothing and does not run guard', async t => {
  const f = await fixture(t);
  await rm(f.path);
  await blocked(f, intent(), 'CLIENT');
  assert.equal(f.events.includes('guard'), false);
});

for (const [name, input, code] of [
  ['wrong run', { runId: 'run-b' }, 'IDENTITY'],
  ['wrong session', { sessionId: 'session-b' }, 'IDENTITY'],
  ['stale revision', { expectedRevision: 3 }, 'IDENTITY'],
  ['missing revision', { expectedRevision: undefined }, 'IDENTITY'],
  ['unapproved action', { approved: false }, 'APPROVAL'],
  ['truthy approval', { approved: 'yes' }, 'APPROVAL'],
  ['typo operation', { operation: 'attak' }, 'OPERATION'],
  ['raw tool', { operation: 'act' }, 'OPERATION'],
  ['unenabled operation', { operation: "eat" }, 'OPERATION'],
  ['invalid arguments', { args: { target: 'anything' } }, 'ARGUMENTS'],
  ['identity override', { args: { target: { x: 11, y: 10 }, sessionId: 'session-b' } }, 'ARGUMENTS'],
  ['receipt override', { args: { target: { x: 11, y: 10 }, operationId: 'fake' } }, 'ARGUMENTS'],
  ['extra intent', { force: true }, 'INTENT'],
]) {
  test(`${name} sends nothing`, async t => {
    await blocked(await fixture(t), intent(input), code);
  });
}

for (const changed of [{ runId: 'run-b' }, { sessionId: 'session-b' }, { revision: 3 }]) {
  test(`OK guard with mismatched ${Object.keys(changed)} sends nothing`, async t => {
    const f = await fixture(t, { guard: context => ({ ...allow(context), ...changed }) });
    await blocked(f, intent(), 'GUARD_IDENTITY');
  });
}

for (const change of [
  state => { state.status = 'uncertain'; },
  state => { state.pendingRequest = { name: 'attack' }; },
  state => { state.snapshot.ended = true; state.snapshot.end = { kind: 'death' }; },
  state => { delete state.snapshot.decision; },
  state => { state.snapshot.sessionId = 'rotated-hero'; },
]) {
  test(`unusable current state (${change.toString()}) sends nothing`, async t => {
    const state = initialState(); change(state);
    const f = await fixture(t, { state });
    await blocked(f, intent());
    assert.equal(f.events.includes('guard'), false);
  });
}

test('standing decisions require exact explicit answers or cancellation', async t => {
  const state = initialState();
  state.snapshot.decision = { id: 'decision-new', kind: 'confirmation', cancellable: true };
  for (const operation of ['attack', "answer", "cancel"]) {
    const f = await fixture(t, { state });
    const args = operation === 'attack' ? intent().args : { decisionId: 'decision-old',
      ...(operation === "answer" ? { value: false } : {}) };
    await blocked(f, intent({ operation, args }), 'DECISION');
  }
  for (const operation of ["answer", "cancel"]) {
    const f = await fixture(t, { state });
    const args = { decisionId: 'decision-new', ...(operation === "answer"
      ? { value: false } : {}) };
    await f.dispatch(intent({ operation, args }));
    assert.equal(f.outbound.length, 1);
    assert.deepEqual(f.outbound[0].arguments, { ...args, sessionId: 'session-a', expectedRevision: 4 });
  }
});

test('no standing decision is never invented by the dispatcher', async t => {
  const f = await fixture(t);
  await blocked(f, intent({ operation: "cancel", args: { decisionId: 'invented' } }), 'DECISION');
});

test('navigation requires an explicit finite action bound', async t => {
  for (const maxActions of [undefined, 0, -1, Infinity, 1660]) {
    const f = await fixture(t);
    await blocked(f, intent({ operation: 'go', args: { to: { x: 12, y: 10 }, maxActions } }), 'ARGUMENTS');
  }
  const f = await fixture(t);
  await f.dispatch(intent({ operation: 'go', args: { to: { x: 12, y: 10 }, maxActions: 2 } }));
  assert.equal(f.outbound.length, 1);
});

test('concurrent approved intents cannot both use one old revision', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.dispatch(intent()), f.dispatch(intent())]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.code, 'IDENTITY');
  assert.equal(f.outbound.length, 1);
});

test('async guard is awaited and caller cannot alter approved intent while it runs', async t => {
  let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { guard: async context => {
    assert.ok(Object.isFrozen(context.intent.args.target));
    assert.ok(Object.isFrozen(context.state.snapshot));
    entered(); await gate; return allow(context);
  } });
  const input = intent();
  const pending = f.dispatch(input);
  await waiting;
  input.args.target.x = 77;
  assert.equal(f.outbound.length, 0);
  release(); await pending;
  assert.equal(f.outbound[0].arguments.target.x, 11);
});

test('transport failure is uncertain, retains cause and never automatically resends', async t => {
  const sendError = new Error('receipt response lost');
  const f = await fixture(t, { sendError });
  await assert.rejects(f.dispatch(intent()), error => error.code === 'SEND'
    && error.sendAttempted === true && error.cause === sendError);
  assert.equal(f.outbound.length, 1);
});

test('configuration has no unguarded or generic-operation fallback', () => {
  assert.throws(() => createDispatcher({}), { code: 'CONFIG' });
  assert.throws(() => createDispatcher({ runId: 'run-a', client: { execute() {} }, guard: allow,
    operations: new Map([['act', () => true]]) }), { code: 'CONFIG' });
});

test('retreat and ranged attempts are supported only with explicit validators', async t => {
  for (const operation of ["moveWithoutAttack", "throw"]) {
    const f = await fixture(t);
    await blocked(f, intent({ operation }), 'OPERATION');
    let calls = 0;
    const validArgs = operation === "throw"
      ? { itemId: 'item-fixture', target: { direction: 'west' } }
      : { direction: 'west' };
    const dispatch = createDispatcher({ runId: 'run-a', guard: allow,
      operations: new Map([[operation, args => JSON.stringify(args) === JSON.stringify(validArgs)]]),
      client: { async execute(call, { preflight }) {
        await preflight(initialState()); calls++; return call;
      } },
    });
    await assert.rejects(dispatch(intent({ operation, args: { direction: 'typo' } })), { code: 'ARGUMENTS' });
    assert.equal(calls, 0);
    const response = await dispatch(intent({ operation, args: validArgs }));
    assert.equal(response.name, operation);
    assert.equal(calls, 1);
  }
});

for (const [name, change] of [
  ['raw delta', snapshot => { snapshot.update = { kind: 'delta', id: 2, base: 1 }; }],
  ['error', snapshot => { snapshot.error = { code: 'badInput' }; }],
  ['unknown outcome', snapshot => { snapshot.outcome.status = 'unknown'; }],
  ['missing outcome', snapshot => { delete snapshot.outcome; }],
  ['missing observation', snapshot => { delete snapshot.observation; }],
  ['historical receipt', snapshot => { snapshot.historical = true; }],
  ['failed storage', snapshot => { snapshot.storage = { status: 'error' }; }],
  ['failed recording', snapshot => { snapshot.recording = { status: 'uncertain' }; }],
  ['unknown storage', snapshot => { snapshot.storage = null; }],
]) {
  test(`mislabeled current envelope containing ${name} sends nothing`, async t => {
    const state = initialState(); change(state.snapshot);
    await blocked(await fixture(t, { state }), intent(), 'STATE');
  });
}

test('supplied input gates are enforced, including neighborhood gate and exact decision', async t => {
  for (const gate of [null, {}, { state: 'recoveryRequired' }, { state: 'unavailable' },
    { state: 'ended' }, { state: 'decision', decisionId: 'unasked' }]) {
    const state = initialState();
    state.snapshot.observation.neighborhood = { inputGate: gate };
    await blocked(await fixture(t, { state }), intent(), 'INPUT_GATE');
  }
  const state = initialState();
  state.snapshot.inputGate = { state: 'ready' };
  const f = await fixture(t, { state });
  await f.dispatch(intent());
  assert.equal(f.outbound.length, 1);
  state.snapshot.decision = { id: 'decision-new', kind: 'confirmation' };
  state.snapshot.inputGate = { state: 'decision', decisionId: 'decision-old' };
  const answer = intent({ operation: "cancel", args: { decisionId: 'decision-new' } });
  await blocked(await fixture(t, { state }), answer, 'INPUT_GATE');
  state.snapshot.inputGate.decisionId = 'decision-new';
  const exact = await fixture(t, { state });
  await exact.dispatch(answer);
  assert.equal(exact.outbound.length, 1);
});
