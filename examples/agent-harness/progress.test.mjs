import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgressBudget } from './progress.mjs';

const target = { x: 20, y: 7 };
const cell = (x = 20, y = 7) => ({ x, y, visible: true,
  terrain: { type: 'floor', knowledge: 'remembered', freshness: 'current' } });
const snapshot = () => ({ sessionId: 'disposable-run', revision: 1, decision: null, ended: false,
  outcome: { status: 'completed', turnsElapsed: 0, positionChanged: false },
  observation: { location: { id: 'level-0-4' }, you: { x: 19, y: 7 }, turn: 2442,
    world: [cell(), cell(19, 8)], heard: [] } });
const begin = (budget, s, extra = {}) => budget.begin({ intent: 'walk-to-exit', snapshot: s, target, ...extra });
const settle = (budget, token, s, status = 'ok') => budget.settle(token, { status, snapshot: s });

test('recorded ids 2371–2374: one input then stop across caller invocations', () => {
  // Public scalar projection checked against run014 response lines 4740–4748.
  // Map below is a disposable fixture, not a reconstruction of the omitted map.
  const budget = createProgressBudget();
  const before = snapshot();
  before.revision = 2472;
  let calls = 0;
  const first = begin(budget, before);
  assert.equal(first.allowed, true);
  calls++;
  const response2371 = snapshot();
  response2371.revision = 2473;
  assert.equal(settle(budget, first.token, response2371).reason, 'noProgress');
  for (const [id, revision] of [[2372, 2474], [2373, 2475], [2374, 2476]]) {
    const recorded = snapshot();
    recorded.revision = revision;
    recorded.requestId = String(id);
    recorded.summary = 'moveWithoutAttack: completed; 0 turns elapsed.';
    assert.equal(begin(budget, recorded).reason, 'noProgress');
  }
  assert.equal(calls, 1);
});

test('turns, actionsTaken, completed summary, rolling heard and irrelevant reveals are not progress', () => {
  const budget = createProgressBudget();
  const first = begin(budget, snapshot());
  const after = snapshot();
  after.revision++;
  after.observation.turn++;
  after.outcome.turnsElapsed = 1;
  after.navigation = { actionsTaken: 3 };
  after.summary = 'Navigation: arrived';
  after.observation.heard.push('You move right into the floating eye.');
  after.observation.world.push(cell(50, 12));
  after.creatures = [{ appearance: 'new creature' }];
  assert.equal(settle(budget, first.token, after).progress, false);
  assert.equal(begin(budget, after).reason, 'noProgress');
});

test('currently witnessed pet displacement reopens a blocked target once', () => {
  const budget = createProgressBudget();
  const pet = snapshot();
  pet.observation.world[0].occupant = { kind: 'ally', mark: 'd', attitude: 'tame' };
  const first = begin(budget, pet);
  settle(budget, first.token, pet);
  assert.equal(begin(budget, pet).allowed, false);
  const cleared = snapshot();
  const second = begin(budget, cleared);
  assert.equal(second.allowed, true);
  assert.equal(settle(budget, second.token, cleared).reason, 'noProgress');
  assert.equal(begin(budget, cleared).allowed, false);
});

test('actual movement and level identity count; intent cap survives oscillation', () => {
  const budget = createProgressBudget({ maxAttempts: 2 });
  const initial = snapshot();
  const first = begin(budget, initial);
  const moved = snapshot();
  moved.observation.you.x++;
  assert.equal(settle(budget, first.token, moved).changes.moved, true);
  const second = begin(budget, moved);
  const otherLevel = snapshot();
  otherLevel.observation.location.id = 'level-2-1';
  const result = settle(budget, second.token, otherLevel);
  assert.equal(result.changes.moved, true);
  assert.equal(result.reason, 'attemptLimit');
  assert.equal(begin(budget, initial).reason, 'attemptLimit');
});

test('a changed target obstacle is progress without position or turn changes', () => {
  const budget = createProgressBudget();
  const before = snapshot();
  before.observation.world[0].terrain.type = 'closedDoor';
  const first = begin(budget, before);
  const result = settle(budget, first.token, snapshot());
  assert.deepEqual(result.changes, { moved: false, obstacleChanged: true, revealed: true });
  assert.equal(result.allowed, true);
});

test('new target knowledge counts once, without clearing failed edge accounting', () => {
  const budget = createProgressBudget();
  const unknown = snapshot();
  unknown.observation.world = [];
  const first = begin(budget, unknown);
  const result = settle(budget, first.token, snapshot());
  assert.equal(result.changes.revealed, true);
  assert.equal(begin(budget, snapshot()).reason, 'noProgress');
});

test('visibility loss and reordering do not count as an obstacle clearing', () => {
  const budget = createProgressBudget();
  const before = snapshot();
  before.observation.world[0].occupant = { kind: 'creature', mark: 'e' };
  const first = begin(budget, before);
  const after = snapshot();
  after.observation.world[0].visible = false;
  after.observation.world.reverse();
  assert.equal(settle(budget, first.token, after).progress, false);
  assert.equal(begin(budget, after).reason, 'noProgress');
});

for (const status of ['unknown', 'error', 'futureStatus']) {
  test(`${status} settlement latches stop even with an apparently moved snapshot`, () => {
    const budget = createProgressBudget();
    const first = begin(budget, snapshot());
    const after = snapshot();
    after.observation.you.x++;
    assert.equal(settle(budget, first.token, after, status).progress, false);
    assert.equal(begin(budget, after, { intent: 'new-caller-intent' }).allowed, false);
  });
}

test('missing snapshot, explicit errors, and unknown outcomes fail closed despite ok classification', () => {
  for (const after of [undefined, { error: { code: 'outOfReach' } },
    { ...snapshot(), outcome: { status: 'unknown' } }, { ...snapshot(), sessionId: 'another-run' }]) {
    const budget = createProgressBudget();
    const first = begin(budget, snapshot());
    assert.equal(settle(budget, first.token, after).allowed, false);
    assert.equal(begin(budget, snapshot()).allowed, false);
  }
});

test('pending input and foreign/reused token never license another input', () => {
  const budget = createProgressBudget();
  const original = begin(budget, snapshot());
  assert.equal(begin(budget, snapshot(), { intent: 'other' }).reason, 'pendingReceipt');
  assert.equal(settle(budget, {}, snapshot()).reason, 'invalidReceiptToken');
  assert.equal(begin(budget, snapshot()).allowed, false);
  const moved = snapshot();
  moved.observation.you.x++;
  assert.equal(settle(budget, original.token, moved).allowed, false);
  const secondBudget = createProgressBudget();
  const attempt = begin(secondBudget, snapshot());
  settle(secondBudget, attempt.token, snapshot());
  assert.equal(settle(secondBudget, attempt.token, snapshot()).reason, 'invalidReceiptToken');
});

test('terrain becoming unknown is not a witnessed obstacle change', () => {
  const budget = createProgressBudget();
  const first = begin(budget, snapshot());
  const after = snapshot();
  after.observation.world[0].terrain.type = 'unknown';
  assert.equal(settle(budget, first.token, after).progress, false);
});

test('decisions and endings stop even when movement occurred', () => {
  for (const patch of [{ decision: { id: 'exact-choice', kind: 'confirmation' } }, { ended: true }]) {
    const budget = createProgressBudget();
    const first = begin(budget, snapshot());
    const after = { ...snapshot(), ...patch };
    after.observation.you.x++;
    assert.equal(settle(budget, first.token, after).allowed, false);
    assert.equal(begin(budget, after).allowed, false);
    if (after.decision) assert.equal(after.decision.id, 'exact-choice');
  }
});

test('floor occupants/hazards remain visible to policy, alternatives are never auto-executed', () => {
  const budget = createProgressBudget();
  const s = snapshot();
  s.observation.neighborhood = { status: 'available', basis: {
    revision: s.revision, levelId: s.observation.location.id, origin: s.observation.you },
  cells: [{ ...cell(), inBounds: true, occupant: { kind: 'creature', mark: 'e' }, hazards: ['trap'] }] };
  const first = begin(budget, s, { candidates: [target, { x: 19, y: 8 }, { x: 60, y: 9 }] });
  assert.equal(first.obstruction.terrain.type, 'floor');
  assert.equal(first.obstruction.occupant.kind, 'creature');
  assert.deepEqual(first.obstruction.hazards, ['trap']);
  assert.equal(first.alternatives.length, 1);
  assert.equal(first.alternatives[0].x, 19);
  assert.equal('force' in first, false);
  assert.equal(settle(budget, first.token, s).progress, false);
});

test('stale neighborhood and caller mutation cannot invent progress', () => {
  const budget = createProgressBudget();
  const s = snapshot();
  const first = begin(budget, s);
  first.obstruction.terrain.type = 'wall';
  s.observation.neighborhood = { status: 'available', basis: { revision: 0,
    levelId: s.observation.location.id, origin: s.observation.you },
  cells: [{ ...cell(), inBounds: true, terrain: { type: 'lava' } }] };
  assert.equal(settle(budget, first.token, s).progress, false);
});

test('direction aliases share absolute target accounting; independent target is bounded', () => {
  const budget = createProgressBudget({ maxNoProgress: 2, maxAttempts: 3 });
  for (let i = 0; i < 2; i++) {
    const attempt = begin(budget, snapshot());
    assert.equal(attempt.allowed, true);
    settle(budget, attempt.token, snapshot());
  }
  assert.equal(begin(budget, snapshot()).reason, 'noProgress');
  const south = begin(budget, snapshot(), { target: { x: 19, y: 8 } });
  assert.equal(south.allowed, true);
  settle(budget, south.token, snapshot());
  assert.equal(begin(budget, snapshot()).reason, 'attemptLimit');
});

test('invalid budgets and unknown input position cannot reserve inputs', () => {
  for (const n of [0, -1, 1.5, Infinity]) assert.throws(() => createProgressBudget({ maxAttempts: n }));
  const budget = createProgressBudget();
  assert.equal(begin(budget, {}).reason, 'unknownSnapshot');
  assert.equal(begin(budget, snapshot(), { target: { x: NaN, y: 7 } }).reason, 'invalidIntent');
});

for (const [name, patch] of [
  ['raw delta', { update: { kind: 'delta', id: 2, base: 1 } }],
  ['unknown update', { update: { kind: 'futureFormat', id: 2 } }],
  ['historical receipt', { historical: true }],
  ['failed storage', { storage: { status: 'failed' } }],
  ['failed recording', { recording: { status: 'failed' } }],
  ['unknown storage diagnostic', { storage: {} }],
]) {
  test(`${name} latches begin and settle despite apparent motion and status ok`, () => {
    const flagged = { ...snapshot(), ...patch };
    flagged.observation.you.x++;
    const beforeBudget = createProgressBudget();
    const rejected = begin(beforeBudget, flagged);
    assert.equal(rejected.reason, 'uncertainResponse');
    assert.equal(rejected.progress, false);
    assert.equal('token' in rejected, false);
    assert.equal(begin(beforeBudget, snapshot()).reason, 'uncertainResponse');

    const afterBudget = createProgressBudget();
    const attempt = begin(afterBudget, snapshot());
    const result = settle(afterBudget, attempt.token, flagged, 'ok');
    assert.equal(result.reason, 'uncertainResponse');
    assert.equal(result.progress, false);
    assert.equal(begin(afterBudget, snapshot()).reason, 'uncertainResponse');
  });
}

test('full current snapshots with ok diagnostics still describe level movement', () => {
  const budget = createProgressBudget();
  const s = { ...snapshot(), update: { kind: 'snapshot', id: 1 }, historical: false,
    storage: { status: 'ok' }, recording: { status: 'ok' } };
  const first = begin(budget, s);
  assert.equal(first.allowed, true);
  const after = structuredClone(s);
  after.observation.location.id = 'level-2-1';
  const result = settle(budget, first.token, after);
  assert.equal(result.progress, true);
  assert.equal(result.changes.moved, true);
});

test('all coordinates require safe integers: targets, hero, candidates, world and neighborhood', () => {
  const unsafe = Number.MAX_SAFE_INTEGER + 1;
  const budget = createProgressBudget();
  assert.equal(begin(budget, snapshot(), { target: { x: unsafe, y: 7 } }).reason, 'invalidIntent');
  const invalidHero = snapshot();
  invalidHero.observation.you.x = unsafe;
  assert.equal(begin(budget, invalidHero).reason, 'unknownSnapshot');
  const s = snapshot();
  s.observation.world.push(cell(unsafe, 7));
  s.observation.neighborhood = { status: 'available', basis: { revision: s.revision,
    levelId: s.observation.location.id, origin: s.observation.you },
  cells: [{ ...cell(unsafe, 7), inBounds: true }] };
  const first = begin(budget, s, { candidates: [{ x: unsafe, y: 7 }] });
  assert.deepEqual(first.alternatives, []);
  assert.equal(settle(budget, first.token, invalidHero).reason, 'uncertainResponse');

  const secondBudget = createProgressBudget();
  const second = begin(secondBudget, snapshot());
  const after = snapshot();
  after.observation.neighborhood = { status: 'available', basis: { revision: after.revision,
    levelId: after.observation.location.id, origin: { x: unsafe, y: 7 } },
  cells: [{ ...cell(), inBounds: true, terrain: { type: 'lava' } }] };
  assert.equal(settle(secondBudget, second.token, after).progress, false);
});
