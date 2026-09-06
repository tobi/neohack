import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, Neonethack } from '../dist/typescript/client.js';
import { ReferenceClient, isRetreatStep } from '../dist/typescript/reference-client.js';

function frame() {
  return { version: 1, sessionId: 'public-life', requestId: null, revision: 0,
    outcome: { action: 'observe', status: 'completed', turnsElapsed: 0, positionChanged: false, effects: [] },
    observation: { turn: 1, location: { id: 'level', depthLabel: 'Dlvl:1' }, you: { x: 1, y: 1 },
      vitals: { hunger: 'Fainting' }, world: [{ x: 2, y: 1, visible: false, terrain: { type: 'floor', knowledge: 'remembered' }, occupant: { kind: 'creature', mark: 'e', appearance: 'floating eye' } }],
      inventory: [], inventoryKnown: true, here: { known: true, items: [] }, perception: { inventory: 'current', here: 'current', equipment: 'current' }, heard: [],
      neighborhood: { version: 1, status: 'available', basis: { revision: 0, levelId: 'level', origin: { x: 1, y: 1 } }, inputGate: { state: 'ready' }, cells: [] } },
    events: [], decision: null, ended: false, end: null };
}
function setup(initial = frame(), handle) {
  let state = structuredClone(initial), count = 0; const sent = [];
  const transport = { close: async () => {}, async send(request) {
    sent.push(request);
    if (handle) return handle(request, state);
    state = structuredClone(state); state.revision++;
    if (request.method === 'game.move') state.observation.you.x += request.params.direction === 'east' ? 1 : -1;
    state.outcome.positionChanged = request.method === 'game.move';
    if (request.method === 'game.search') state.observation.turn++;
    if (request.method.startsWith('decision.')) { state.decision = null; state.observation.neighborhood.inputGate = { state: 'ready' }; }
    return state;
  } };
  const game = new Game(new Neonethack(transport), initial, () => `request-${++count}`);
  return { game, client: new ReferenceClient(game), sent };
}

test('reference view preserves remembered world appearance and hunger alongside a creature; never selects combat', () => {
  const { client, sent } = setup();
  assert.equal(client.view.state.observation.world[0].terrain.type, 'floor');
  assert.equal(client.view.state.observation.world[0].visible, false);
  assert.equal(client.view.state.observation.world[0].occupant.appearance, 'floating eye');
  assert.equal(client.view.state.observation.vitals.hunger, 'Fainting');
  assert.equal(sent.length, 0);
});
test('retreat uses movement intent/restriction and freshness, not visibility or relation alone', () => {
  const state = frame();
  const q = { sessionId: state.sessionId, basis: state.observation.neighborhood.basis, inputGate: { state: 'ready' }, cell: {
    inBounds: true, visible: false, walkable: true, terrain: { type: 'floor', freshness: 'remembered' }, movement: { relation: 'adjacent', intent: 'step' },
    actions: [{ method: 'game.move', availability: 'attemptable' }] } };
  assert.equal(isRetreatStep(q, state), true);
  for (const intent of ['possiblePush', 'creatureBump', 'allyBump', 'unknown', 'attemptOpen']) {
    const b = structuredClone(q); b.cell.movement.intent = intent; assert.equal(isRetreatStep(b, state), false);
  }
  for (const patch of [{ occupant: { kind: 'creature' } }, { terrain: { freshness: 'unknown' } }, { movement: { relation: 'adjacent', intent: 'step', knownRestriction: 'lockedDoor' } }]) {
    assert.equal(isRetreatStep({ ...q, cell: { ...q.cell, ...patch } }, state), false);
  }
  assert.equal(isRetreatStep({ ...q, basis: { ...q.basis, revision: 9 } }, state), false);
});
test('distinct decision.id values never alias; warning consent always explicit', async () => {
  for (const id of ['decision-one', 'decision-two']) {
    const s = frame(); s.decision = { id, kind: 'confirmation', action: 'pray', cancellable: true };
    s.observation.neighborhood.inputGate = { state: 'decision', decisionId: id };
    const { client, sent } = setup(s);
    assert.equal(client.view.decisionId, id);
    await assert.rejects(client.choose({ kind: 'search' }), /explicit answer/);
    await assert.rejects(client.choose({ kind: 'answer', decisionId: 'wrong', answer: { kind: 'confirmation', confirm: true } }), /decision.id/);
    await client.choose({ kind: 'answer', decisionId: id, answer: { kind: 'confirmation', confirm: false } });
    assert.equal(sent.length, 1); assert.equal(sent[0].params.decisionId, id); assert.equal(sent[0].params.answer.confirm, false);
  }
});
test('A-B oscillation requires acknowledgement and search can resume after any number of explicit searches', async () => {
  const { client, sent } = setup();
  for (const direction of ['east', 'west', 'east']) await client.choose({ kind: 'move', direction });
  assert.equal(client.view.oscillating, true);
  await assert.rejects(client.choose({ kind: 'move', direction: 'west' }), /oscillation/);
  client.acknowledgeAttempts();
  await client.choose({ kind: 'move', direction: 'west' });
  for (let i = 0; i < 21; i++) await client.choose({ kind: 'search' });
  await client.choose({ kind: 'wait' }); await client.choose({ kind: 'search' });
  assert.equal(sent.filter(r => r.method === 'game.search').length, 22);
  assert.ok(client.view.attempts.length <= 16);
});
test('no-progress attempt memory is uncertain evidence, never a permanent wall', async () => {
  const { client } = setup(frame(), async (_r, s) => ({ ...s, revision: s.revision + 1, outcome: { ...s.outcome, reason: 'noProgress', positionChanged: false } }));
  await client.choose({ kind: 'move', direction: 'east' });
  assert.equal(client.view.attempts[0].outcome.reason, 'noProgress');
  assert.equal(client.view.state.observation.world[0].terrain.type, 'floor');
  await client.choose({ kind: 'move', direction: 'east' });
});
test('unsupported decisions, unavailable gates, ended and degraded stores send no input', async () => {
  for (const mutate of [
    s => { s.decision = { id: 'unknown', kind: 'future', cancellable: true }; },
    s => { s.observation.neighborhood.inputGate = { state: 'unavailable' }; },
    s => { delete s.observation.neighborhood; },
    s => { s.ended = true; s.end = { kind: 'death', turn: 1 }; },
    s => { s.storage = { status: 'degraded' }; },
    s => { s.outcome.status = 'unknown'; },
  ]) {
    const s = frame(); mutate(s); const { client, sent } = setup(s);
    await assert.rejects(client.choose({ kind: 'wait' })); assert.equal(sent.length, 0);
  }
});
test('one writer rejects a second choice and uncertain recovery retains exact immutable request', async () => {
  let release, calls = 0;
  const delayed = new Promise(resolve => { release = resolve; });
  const { client, game, sent } = setup(frame(), async (r, s) => {
    if (++calls === 1) { await delayed; throw Error('lost reply'); }
    return { ...s, requestId: r.params.requestId ?? null, revision: 1 };
  });
  const one = client.choose({ kind: 'search' });
  await assert.rejects(client.choose({ kind: 'wait' }), /in flight/);
  release(); await assert.rejects(one, /may have executed/);
  const exact = game.pendingRequest; assert.ok(Object.isFrozen(exact.params));
  await assert.rejects(client.choose({ kind: 'wait' }), /recovery/);
  await client.recover();
  assert.equal(sent[1], exact); assert.equal(sent[2].method, 'session.observe');
});

test('missing and future outcome statuses cannot authorize even a ready input gate', async () => {
  for (const status of [undefined, 'futureResult', 'unknown']) {
    const s = frame();
    if (status === undefined) delete s.outcome.status; else s.outcome.status = status;
    const { client, sent } = setup(s);
    await assert.rejects(client.choose({ kind: 'wait' }), /recovery/);
    assert.equal(sent.length, 0, `status ${status} must not submit input`);
  }
});
test('retreat rejects missing and future freshness after its free query without sending a movement', async () => {
  for (const freshness of [undefined, 'futureFreshness', 'unknown']) {
    const s = frame();
    const terrain = { type: 'floor' };
    if (freshness !== undefined) terrain.freshness = freshness;
    const q = { version: 1, kind: 'actions', sessionId: s.sessionId,
      basis: s.observation.neighborhood.basis, inputGate: { state: 'ready' }, cell: {
        inBounds: true, walkable: true, terrain, movement: { relation: 'adjacent', intent: 'step' },
        actions: [{ method: 'game.move', availability: 'attemptable' }] } };
    const { client, sent } = setup(s, async () => q);
    await assert.rejects(client.choose({ kind: 'retreatStep', direction: 'east' }), /not a disclosed ordinary step/);
    assert.deepEqual(sent.map(r => r.method), ['session.actions']);
    assert.equal(isRetreatStep(q, s), false);
  }
});
test('unrecognized receipt or current observation cannot resolve uncertainty even when Game retains a newer valid frame', async () => {
  for (const stage of ['receipt', 'observation']) for (const status of [undefined, 'futureResult', 'unknown']) {
    const initial = frame(); initial.revision = 10;
    let calls = 0;
    const { client, game, sent } = setup(initial, async (request, state) => {
      if (++calls === 1) throw Error('lost reply');
      const result = structuredClone(state);
      // An old receipt/query cannot replace Game's newer snapshot. The sample
      // must retain its own recovery stop, not trust that old valid snapshot.
      result.revision = 9;
      if ((stage === 'receipt' && request.method !== 'session.observe')
        || (stage === 'observation' && request.method === 'session.observe')) {
        if (status === undefined) delete result.outcome.status; else result.outcome.status = status;
      }
      return result;
    });
    await assert.rejects(client.choose({ kind: 'search' }), /may have executed/);
    await assert.rejects(client.recover(), /uncertain/);
    assert.equal(game.state.revision, 10);
    const count = sent.length;
    await assert.rejects(client.choose({ kind: 'wait' }), /recovery/);
    assert.equal(sent.length, count, `${stage} ${status} must not authorize input`);
    assert.equal(sent.filter(r => r.method === 'game.search').length, 2, 'only exact original receipt request is retried');
    assert.equal(sent.filter(r => r.method === 'session.observe').length, stage === 'receipt' ? 0 : 1);
  }
});
