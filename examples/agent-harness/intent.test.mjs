import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { bindIntent, validateIntent, createIntentQueue } from './intent.mjs';

// Disposable public-shape fixtures, not recordings or hidden engine state.
const clone = value => structuredClone(value);
function frame(appearance = 'gnome') {
  return { sessionId: 'disposable', revision: 1, ended: false, end: null, decision: null,
    outcome: { action: 'get_state', status: 'completed', turnsElapsed: 0, effects: [] },
    observation: { turn: 1, location: { id: 'level-test' }, you: { x: 36, y: 8 },
      vitals: { health: 30, hunger: 'not_hungry', burden: 'unencumbered', condition: [] },
      inventoryKnown: true, perception: { inventory: 'current', equipment: 'current' },
      inventory: [{ id: 'item-54', quantity: 1, label: 'spear', usage: ['wielded'] }],
      world: [{ x: 36, y: 9, visible: true,
        terrain: { type: 'floor', knowledge: 'remembered', freshness: 'current' },
        occupant: { kind: 'creature', appearance, attitude: 'hostile', mark: 'G', color: 8 } }] },
    creatures: [{ id: 'c-disposable-1-36-9' }], events: [] };
}
function spec(overrides = {}) {
  return { action: 'attack', target: { kind: 'creature', x: 36, y: 9 },
    itemRefs: [], goal: 'fight perceived gnome', maxActions: 2, ...overrides };
}
function bind(f, s = spec()) {
  const result = bindIntent(f, s);
  assert.equal(result.allowed, true, result.reason);
  return result.intent;
}
function result(before, change = () => {}) {
  const after = clone(before);
  after.revision++;
  after.observation.turn++;
  after.outcome = { action: 'attack', status: 'completed', turnsElapsed: 1, effects: ['attacked'] };
  after.creatures = [{ id: `c-disposable-${after.revision}-36-9` }];
  change(after);
  return after;
}
function next(q, f, goal = 'fight perceived gnome') { return q.next(f, { goal }); }
function door() {
  const f = frame();
  delete f.observation.world[0].occupant;
  f.observation.world[0].terrain.type = 'closedDoor';
  return f;
}
const doorSpec = () => spec({ action: 'kick', target: { kind: 'obstacle', x: 36, y: 9 } });

test('kill response: vanished target permits zero additional attacks, even if it returns later', () => {
  const f = frame(), q = createIntentQueue(bind(f));
  assert.equal(next(q, f).allowed, true);
  const killed = result(f, r => { delete r.observation.world[0].occupant; });
  assert.equal(q.settle(killed).reason, 'targetDisappeared');
  assert.equal(next(q, result(killed)).allowed, false);
  assert.equal(next(q, frame()).actionsIssued, 1);
});

test('opened door/shopkeeper response permits zero additional kicks', () => {
  const f = door(), q = createIntentQueue(bind(f, doorSpec()));
  assert.equal(next(q, f).allowed, true);
  const opened = result(f, r => {
    r.outcome.action = 'kick'; r.outcome.effects = ['openedDoor', 'kicked'];
    r.observation.world[0].terrain.type = 'floor';
    r.observation.world[0].occupant = { kind: 'creature', appearance: 'shopkeeper', attitude: 'hostile' };
  });
  assert.equal(q.settle(opened).allowed, false);
  assert.equal(next(q, opened).actionsIssued, 1);
});

test('gecko to gas spore square reuse invalidates gecko intent; fresh explicit spore intent is allowed', () => {
  const f = frame('gecko'), intent = bind(f);
  const spore = result(f, r => { r.observation.world[0].occupant.appearance = 'gas spore'; });
  assert.equal(validateIntent(intent, spore, { goal: intent.goal }).reason, 'targetChanged');
  const q = createIntentQueue(intent);
  assert.equal(next(q, spore).actionsIssued, 0);
  assert.equal(bindIntent(spore, spec({ goal: 'explicit new gas spore decision' })).allowed, true);
});

test('two unchanged perceived attacks work despite revision-local IDs and stop at bound', () => {
  const f = frame(), q = createIntentQueue(bind(f)), a = result(f), b = result(a);
  assert.equal(next(q, f).command.basis.revision, 1);
  assert.equal(q.settle(a).allowed, true);
  assert.equal(next(q, a).command.basis.revision, 2);
  assert.equal(q.settle(b).reason, 'boundReached');
  assert.equal(next(q, b).actionsIssued, 2);
});

test('latest frame is revalidated before issuing the next queued action', () => {
  const f = frame(), q = createIntentQueue(bind(f)), a = result(f);
  next(q, f); q.settle(a);
  delete a.observation.world[0].occupant;
  assert.equal(next(q, a).reason, 'targetDisappeared');
});

for (const [name, mutate, reason] of [
  ['appearance', f => { f.observation.world[0].occupant.appearance = 'dwarf'; }, 'targetChanged'],
  ['attitude', f => { f.observation.world[0].occupant.attitude = 'peaceful'; }, 'targetChanged'],
  ['position', f => { f.observation.you.x++; }, 'positionChanged'],
  ['level', f => { f.observation.location.id = 'another'; }, 'positionChanged'],
  ['health', f => { f.observation.vitals.health--; }, 'conditionChanged'],
  ['condition', f => { f.observation.vitals.condition.push('confused'); }, 'conditionChanged'],
  ['hunger', f => { f.observation.vitals.hunger = 'hungry'; }, 'conditionChanged'],
  ['burden', f => { f.observation.vitals.burden = 'burdened'; }, 'conditionChanged'],
  ['equipment', f => { f.observation.inventory[0].usage = []; }, 'equipmentChanged'],
  ['session', f => { f.sessionId = 'another'; }, 'sessionChanged'],
  ['remembered terrain', f => { f.observation.world[0].terrain.freshness = 'remembered'; }, 'targetUncertain'],
  ['invisible target', f => { f.observation.world[0].visible = false; }, 'targetUncertain'],
  ['unknown attitude', f => { delete f.observation.world[0].occupant.attitude; }, 'targetUncertain'],
  ['missing world', f => { delete f.observation.world; }, 'uncertainFrame'],
  ['delta', f => { f.update = { kind: 'delta' }; }, 'uncertainFrame'],
  ['unknown inventory', f => { f.observation.perception.inventory = 'lastKnown'; }, 'uncertainInventory'],
  ['decision', f => { f.decision = { id: 'exact-question', kind: 'confirmation' }; }, 'decision'],
  ['terminal', f => { f.ended = true; }, 'ended'],
  ['recovery gate', f => { f.observation.neighborhood = { inputGate: { state: 'recoveryRequired' } }; }, 'inputUnavailable'],
  ['top-level gate', f => { f.inputGate = { state: 'recoveryRequired' }; }, 'inputUnavailable'],
  ['degraded storage', f => { f.storage = { status: 'degraded' }; }, 'uncertainStorage'],
  ['degraded recording', f => { f.recording = { status: 'degraded' }; }, 'uncertainStorage'],
  ['unknown outcome', f => { f.outcome.status = 'unknown'; }, 'uncertainOutcome'],
  ['missing outcome', f => { delete f.outcome; }, 'uncertainOutcome'],
]) test(`stop on ${name}`, () => {
  const f = frame(), q = createIntentQueue(bind(f)); mutate(f);
  const stopped = next(q, f);
  assert.equal(stopped.reason, reason); assert.equal(stopped.needsPolicy, true);
  assert.equal(next(q, frame()).allowed, false);
});

test('fresh binding rejects unknown results, storage faults and both blocked gates', () => {
  for (const mutate of [
    f => { f.outcome.status = 'unknown'; },
    f => { f.outcome.status = 'future'; },
    f => { delete f.outcome; },
    f => { f.storage = { status: 'degraded' }; },
    f => { f.recording = { status: 'degraded' }; },
    f => { f.inputGate = { state: 'unavailable' }; },
    f => { f.observation.neighborhood = { inputGate: { state: 'recoveryRequired' } }; },
  ]) {
    const f = frame();
    f.inputGate = { state: 'ready' };
    f.observation.neighborhood = { inputGate: { state: 'ready' } };
    mutate(f);
    assert.equal(bindIntent(f, spec()).allowed, false);
  }
});

test('goal change and unrelated intervening rest require fresh policy', () => {
  const f = frame(), q = createIntentQueue(bind(f));
  assert.equal(next(q, f, 'rest').reason, 'goalChanged');
  const other = createIntentQueue(bind(f));
  assert.equal(next(other, result(f)).reason, 'interveningInput');
});

test('exact item reference required; identical labels cannot replace it', () => {
  const f = frame(); f.observation.inventory.push({ id: 'item-tool', label: 'key', usage: [], quantity: 1 });
  const s = spec({ itemRefs: ['item-tool'] }), intent = bind(f, s);
  const changed = clone(f); changed.observation.inventory[1].id = 'item-other';
  assert.equal(validateIntent(intent, changed, { goal: s.goal }).reason, 'itemChanged');
  changed.observation.inventory[1].id = 'item-tool'; changed.observation.inventory[1].quantity = 2;
  assert.equal(validateIntent(intent, changed, { goal: s.goal }).reason, 'itemChanged');
  assert.equal(bindIntent(f, spec({ itemRefs: ['key'] })).reason, 'itemUnavailable');
});

for (const [name, mutate, reason] of [
  ['interruption', r => { r.outcome.status = 'interrupted'; }, 'actionNotCompleted'],
  ['blocked', r => { r.outcome.status = 'blocked'; }, 'actionNotCompleted'],
  ['unknown status', r => { r.outcome.status = 'future-status'; }, 'uncertainOutcome'],
  ['empty effects', r => { r.outcome.effects = []; }, 'noProgress'],
  ['explicit no progress', r => { r.outcome.reason = 'noProgress'; }, 'noProgress'],
  ['interrupted effect', r => { r.outcome.effects.push('activityInterrupted'); }, 'actionNotCompleted'],
  ['zero turns', r => { r.outcome.turnsElapsed = 0; r.observation.turn--; }, 'noProgress'],
  ['missing receipt', r => { delete r.outcome; }, 'uncertainOutcome'],
  ['mismatched action', r => { r.outcome.action = 'rest'; }, 'uncertainResult'],
  ['mismatched turns', r => { r.outcome.turnsElapsed = 40; }, 'uncertainResult'],
  ['mismatched revision', r => { r.revision++; }, 'uncertainResult'],
]) test(`result stops on ${name}`, () => {
  const f = frame(), q = createIntentQueue(bind(f)); next(q, f);
  const r = result(f, mutate);
  assert.equal(q.settle(r).reason, reason);
  assert.equal(next(q, r).actionsIssued, 1);
});

test('unchanged obstacle kick stops despite spent turn and kicked effect', () => {
  const f = door(), q = createIntentQueue(bind(f, doorSpec())); next(q, f);
  assert.equal(q.settle(result(f, r => {
    r.outcome.action = 'kick'; r.outcome.effects = ['kicked'];
  })).reason, 'noProgress');
});

test('pending action, absent response and duplicate settlement never authorize retry', () => {
  const f = frame(), q = createIntentQueue(bind(f)); next(q, f);
  assert.equal(next(q, f).reason, 'unsettledAction');
  assert.equal(q.settle(result(f)).allowed, false);
  const missing = createIntentQueue(bind(f)); next(missing, f);
  assert.equal(missing.settle(undefined).reason, 'uncertainFrame');
  const twice = createIntentQueue(bind(f)); next(twice, f); twice.settle(result(f));
  assert.equal(twice.settle(result(f)).reason, 'unexpectedResult');
});

test('explicit stop with no reason remains latched', () => {
  const f = frame(), q = createIntentQueue(bind(f));
  assert.equal(q.stop().reason, 'policyStopped');
  assert.equal(next(q, f).actionsIssued, 0);
});

test('caller mutation cannot change binding or command reservation', () => {
  const f = frame(), s = spec(), intent = bind(f, s), q = createIntentQueue(intent);
  s.target.x = 99;
  const issued = next(q, f); issued.command.target.x = 99;
  f.observation.you.x = 99;
  assert.equal(q.settle(result(frame())).allowed, true);
  assert.equal(next(q, result(frame())).command.target.x, 36);
});

test('progress injection cannot override target/decision validation', () => {
  const f = frame(), q = createIntentQueue(bind(f), { madeProgress: () => true }); next(q, f);
  assert.equal(q.settle(result(f, r => { r.decision = { id: 'question' }; })).reason, 'decision');
  const throws = createIntentQueue(bind(f), { madeProgress() { throw Error('uncertain'); } }); next(throws, f);
  assert.equal(throws.settle(result(f)).reason, 'uncertainProgress');
});

test('invalid bound, nonadjacent target and raw key action are rejected', () => {
  for (const maxActions of [0, -1, Infinity, 1.5, 101])
    assert.equal(bindIntent(frame(), spec({ maxActions })).allowed, false);
  assert.equal(bindIntent(frame(), spec({ action: 'raw_key' })).allowed, false);
  assert.equal(bindIntent(frame(), spec({ target: { kind: 'creature', x: 55, y: 9 } })).reason, 'targetNotAdjacent');
});

// Optional read-only audit replay. No archived files are shipped or modified.
// NEO43_REPLAY_ROOT=/path/to/neohack-overnight-20260908 node --test .../intent.test.mjs
// Hashes come from the task attachment manifest; a changed log fails validation.
if (process.env.NEO43_REPLAY_ROOT) {
  const hashes = {
    run004: 'f225b036eca693776787d99785d666e0f169f91b32e0ba99010def696aaafbbc',
    run001: '20da4772adb84b29a9b8183d1aed0c9e66808887d0cab53533539122c56b2276',
    run011: '29797448299101a7c12f9f079ac8ce63229afd7495f8cf4a5f869b06f80520bf',
  };
  function recorded(run, ...lines) {
    const bytes = readFileSync(`${process.env.NEO43_REPLAY_ROOT}/${run}/mcp.jsonl`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hashes[run]);
    const rows = bytes.toString('utf8').split('\n');
    return lines.map(line => JSON.parse(rows[line - 1]).message.result.structuredContent);
  }
  test('audit replay run004 request 197 kill: zero additional attacks', () => {
    const [before, killed] = recorded('run004', 392, 394);
    const q = createIntentQueue(bind(before)); next(q, before);
    assert.equal(q.settle(killed).reason, 'targetDisappeared');
    assert.equal(next(q, killed).actionsIssued, 1);
  });
  test('audit replay run001 request 374 opened door: zero additional kicks', () => {
    const [before, opened] = recorded('run001', 746, 748);
    const q = createIntentQueue(bind(before, spec({ action: 'kick', target: { kind: 'obstacle', x: 71, y: 13 } })));
    next(q, before);
    assert.equal(q.settle(opened).allowed, false);
    assert.equal(next(q, opened).actionsIssued, 1);
  });
  test('audit replay run011 requests 91 and 93: gecko intent cannot attack perceived gas spore', () => {
    const [before, killed, rested] = recorded('run011', 180, 182, 186);
    const intent = bind(before, spec({ target: { kind: 'creature', x: 65, y: 9 } }));
    assert.equal(validateIntent(intent, rested, { goal: intent.goal }).reason, 'targetChanged');
    const q = createIntentQueue(intent); next(q, before);
    assert.equal(q.settle(killed).reason, 'targetDisappeared');
    assert.equal(next(q, rested).actionsIssued, 1);
    assert.equal(next(createIntentQueue(intent), rested).actionsIssued, 0);
  });
}
