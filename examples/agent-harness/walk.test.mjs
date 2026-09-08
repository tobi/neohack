import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { captureWalkTarget, runBoundedWalk } from './walk.mjs';

// Disposable public-schema fixtures, not saved games or copied recordings.
function frame() {
  return {
    version: 1, sessionId: 'disposable-run', revision: 1,
    outcome: { action: 'observe', status: 'completed', turnsElapsed: 0, positionChanged: false, effects: [] },
    decision: null, ended: false, end: null, events: [],
    observation: {
      turn: 1, location: { id: 'level-0-1', depthLabel: 'Dlvl:1' }, you: { x: 10, y: 10 },
      vitals: { health: 16, maxHealth: 16, hunger: 'not_hungry', condition: [] },
      inventory: [], inventoryKnown: true, here: { known: true, items: [] },
      perception: { version: 1, inventory: 'current', here: 'current', equipment: 'current' },
      world: [], heard: [],
    },
  };
}
const destination = { x: 12, y: 10 };
function returned(initial = frame(), reason = 'arrived') {
  const f = structuredClone(initial);
  f.revision += 2;
  f.operationId = 'disposable-operation';
  f.observation.turn += 2;
  f.observation.you = { ...destination };
  f.outcome = { action: 'move', status: 'completed', turnsElapsed: 1, positionChanged: true, effects: ['moved'] };
  f.navigation = { reason, actionsTaken: 2, turnsElapsed: 2 };
  return f;
}
async function invoke(initialFrame = frame(), response = returned(initialFrame), options = {}) {
  const sent = [];
  const result = await runBoundedWalk({
    initialFrame, target: captureWalkTarget(initialFrame, destination), maxActions: 5,
    go: async args => { sent.push(args); return response; }, ...options,
  });
  return { result, sent };
}
const reasons = r => r.stops.map(s => s.reason);

test('unchanging ordinary conditions, healing, movement and turn advance permit one bounded leg', async () => {
  const initial = frame();
  initial.observation.vitals.condition = ['flying', 'glowingHands'];
  initial.observation.vitals.health = 15;
  const after = returned(initial);
  after.observation.vitals.condition.reverse();
  after.observation.vitals.health = 16;
  const { result, sent } = await invoke(initial, after);
  assert.equal(result.reason, 'arrived');
  assert.equal(result.reachedTarget, true);
  assert.equal(result.uncertain, false);
  assert.equal(result.frame, after);
  assert.deepEqual(sent, [{ sessionId: initial.sessionId, to: destination, maxActions: 5 }]);
});

test('position-only adjacent hostile stops before any mutation (run013 id128 projected geometry)', async () => {
  const initial = frame();
  initial.observation.you = { x: 42, y: 5 };
  initial.creatures = [{ kind: 'creature', attitude: 'hostile', position: { x: 41, y: 5 } }];
  const { result, sent } = await invoke(initial);
  assert.equal(result.reason, 'creatureNearby');
  assert.equal(sent.length, 0);
});

test('Chebyshev distance catches diagonal creatures; no glyph identity or distance field needed', async () => {
  const initial = frame();
  initial.creatures = [{ kind: 'creature', position: { x: 13, y: 13 } }];
  assert.equal((await invoke(initial)).result.reason, 'creatureNearby');
  initial.creatures[0].position.x = 16;
  assert.equal((await invoke(initial)).result.reason, 'arrived');
});

test('weak to fainting stops after one authorized leg; override does not suppress change', async () => {
  const initial = frame(); initial.observation.vitals.hunger = 'weak';
  const after = returned(initial, 'changed'); after.observation.vitals.hunger = 'fainting';
  after.navigation = { reason: 'changed', actionsTaken: 50, turnsElapsed: 59 };
  const { result, sent } = await invoke(initial, after, { maxActions: 50, override: { reason: 'Caller explicitly attempting a food destination', hunger: 'weak' } });
  assert.equal(sent.length, 1);
  assert.equal(result.reason, 'hungerChanged');
  assert.deepEqual(result.stops[0], { reason: 'hungerChanged', from: 'weak', to: 'fainting' });
  assert.ok(reasons(result).includes('triage'));
  assert.ok(reasons(result).includes('changed'));
});

for (const hunger of ['weak', 'fainting', 'fainted', 'starved', 'unknown']) {
  test(`fresh ${hunger} is triage before movement, even at destination`, async () => {
    const initial = frame(); initial.observation.vitals.hunger = hunger;
    initial.observation.you = { ...destination };
    const { result, sent } = await invoke(initial);
    assert.equal(result.reason, 'triage');
    assert.equal(sent.length, 0);
  });
}

test('foodPoisoned at full HP is triage (run015 id63 projected vitals)', async () => {
  const initial = frame(); initial.observation.vitals.condition = ['foodPoisoned'];
  const { result, sent } = await invoke(initial);
  assert.equal(result.reason, 'triage');
  assert.deepEqual(result.stops[0].conditions, ['foodPoisoned']);
  assert.equal(sent.length, 0);
  const override = { reason: 'Caller deliberately walks to a selected remedy', conditions: ['foodPoisoned'] };
  const deliberate = await invoke(initial, returned(initial), { override });
  assert.equal(deliberate.result.reason, 'arrived');
  assert.deepEqual(deliberate.result.override, override);
});

test('arrival plus damage retains damage context and exact navigation receipt', async () => {
  const after = returned(); after.observation.vitals.health = 9;
  const { result, sent } = await invoke(frame(), after);
  assert.equal(result.reason, 'damage');
  assert.equal(result.reachedTarget, true);
  assert.deepEqual(result.stops[0], { reason: 'damage', from: 16, to: 9 });
  assert.equal(result.frame, after);
  assert.equal(result.frame.navigation.reason, 'arrived');
  assert.equal(sent.length, 1);
});

test('arrival plus new condition or hunger change stops before any continuation', async () => {
  for (const [field, value, reason] of [['condition', ['foodPoisoned'], 'conditionsChanged'], ['hunger', 'hungry', 'hungerChanged']]) {
    const after = returned(); after.observation.vitals[field] = value;
    const { result, sent } = await invoke(frame(), after);
    assert.equal(result.reason, reason);
    assert.equal(sent.length, 1);
  }
});

test('same coordinates on another level invalidate target before and after a call', async () => {
  const initial = frame(), target = captureWalkTarget(initial, destination);
  const other = returned(); other.observation.location.id = 'level-0-2';
  const { result } = await invoke(initial, other);
  assert.equal(result.reason, 'levelChanged');
  assert.equal(result.reachedTarget, false);
  const next = await invoke(other, undefined, { target });
  assert.equal(next.result.reason, 'levelChanged');
  assert.equal(next.sent.length, 0);
});

test('noRoute never causes a force fallback, even next to known floor', async () => {
  const initial = frame();
  initial.observation.world = [{ ...destination, terrain: { type: 'floor', knowledge: 'remembered' } }];
  const after = returned(initial, 'noRoute');
  after.navigation.actionsTaken = 0; after.navigation.turnsElapsed = 0;
  after.observation.you = { ...initial.observation.you };
  const { result, sent } = await invoke(initial, after);
  assert.equal(result.reason, 'noRoute');
  assert.equal(sent.length, 1);
  assert.equal(Object.hasOwn(sent[0], 'force'), false);
});

for (const reason of ['changed', 'interrupted', 'stepLimit', 'attempted', 'aborted', 'error']) {
  test(`${reason} with actionsTaken > 0 returns to caller`, async () => {
    const { result, sent } = await invoke(frame(), returned(frame(), reason));
    assert.equal(result.reason, reason);
    assert.equal(sent.length, 1);
  });
}

test('standing decision and terminal facts outrank arrival and preserve exact context', async () => {
  for (const stage of ['initial', 'response']) {
    for (const reason of ['decision', 'ended']) {
      const initial = frame(), after = returned(initial), chosen = stage === 'initial' ? initial : after;
      if (reason === 'decision') chosen.decision = { id: 'exact-question', kind: 'confirmation', action: 'move', cancellable: true };
      else { chosen.ended = true; chosen.end = { kind: 'death', turn: chosen.observation.turn }; }
      const { result, sent } = await invoke(initial, after);
      assert.equal(result.reason, reason);
      assert.equal(result.frame, chosen);
      assert.equal(sent.length, stage === 'initial' ? 0 : 1);
    }
  }
});

test('schema rejects malformed safety facts, partial/delta frames, and unknown outcomes', async () => {
  const changes = [
    f => delete f.observation.vitals.hunger,
    f => { f.observation.vitals.health = '16'; },
    f => { f.observation.vitals.condition = 'foodPoisoned'; },
    f => { f.creatures = [{ kind: 'creature', attitude: 'hostile', distance: 1 }]; },
    f => { f.observation.you.x = NaN; },
    f => { f.update = { kind: 'delta', id: 2, base: 1 }; },
    f => { f.historical = true; },
    f => { f.outcome.status = 'newStatus'; },
    f => { f.decision = { kind: 'futureDecision' }; },
  ];
  for (const change of changes) {
    const invalid = frame(); change(invalid);
    const { result, sent } = await invoke(frame(), invalid, { initialFrame: invalid });
    assert.equal(result.reason, 'invalidFrame');
    assert.equal(result.uncertain, true);
    assert.equal(sent.length, 0);
  }
  const { result, sent } = await invoke(frame(), { version: 1, error: { code: 'uncertainExecution', message: 'Lost reply' } });
  assert.equal(result.reason, 'invalidFrame');
  assert.equal(result.uncertain, true);
  assert.equal(sent.length, 1);
});

test('transport throw, unknown outcome, stale response and lastConfirmed never retry', async () => {
  const error = new Error('reply lost');
  let calls = 0;
  const thrown = await invoke(frame(), undefined, { go: async () => { calls++; throw error; } });
  assert.equal(thrown.result.reason, 'uncertain');
  assert.equal(thrown.result.stops[0].error, error);
  assert.equal(calls, 1);
  for (const alter of [f => { f.outcome.status = 'unknown'; }, f => { f.revision = 1; }, f => { f.navigation.observation = 'lastConfirmed'; }, f => { f.sessionId = 'another-run'; }]) {
    const after = returned(); alter(after);
    const { result, sent } = await invoke(frame(), after);
    assert.equal(result.uncertain, true);
    assert.equal(sent.length, 1);
  }
});

test('schema-valid inconsistent navigation cannot claim success', async () => {
  for (const alter of [f => delete f.navigation, f => { f.navigation.actionsTaken = 6; }, f => { f.observation.you = { x: 11, y: 10 }; }]) {
    const after = returned(); alter(after);
    const { result, sent } = await invoke(frame(), after);
    assert.equal(result.reason, 'invalidFrame');
    assert.equal(result.uncertain, true);
    assert.equal(sent.length, 1);
  }
});

test('floor with boulder or occupant requires explicit caller intent', async () => {
  for (const [layer, value, reason] of [
    ['objects', [{ kind: 'boulder', mark: '`', color: 7 }], 'targetObject'],
    ['occupant', { kind: 'ally', attitude: 'tame', mark: 'f' }, 'targetOccupied'],
  ]) {
    const initial = frame();
    initial.observation.world = [{ ...destination, terrain: { type: 'floor', knowledge: 'remembered' }, [layer]: value }];
    const { result, sent } = await invoke(initial);
    assert.equal(result.reason, reason);
    assert.equal(sent.length, 0);
  }
});

function neighborhood(f) {
  const { x, y } = f.observation.you;
  return {
    version: 1, status: 'available', radius: 4,
    basis: { revision: f.revision, levelId: f.observation.location.id, origin: { x, y } }, inputGate: { state: 'ready' },
    cells: Array.from({ length: 81 }, (_, i) => {
      const dx = i % 9 - 4, dy = Math.floor(i / 9) - 4;
      return { x: x + dx, y: y + dy, dx, dy, inBounds: true, walkable: true, movement: { relation: 'distant' }, actions: [] };
    }),
  };
}

test('public local hazards override floor appearance; stale local layers stop', async () => {
  const initial = frame(); initial.observation.neighborhood = neighborhood(initial);
  const cell = initial.observation.neighborhood.cells.find(c => c.x === destination.x && c.y === destination.y);
  cell.terrain = { type: 'floor', freshness: 'current' }; cell.hazards = ['trap'];
  assert.equal((await invoke(initial)).result.reason, 'targetHazard');
  delete cell.hazards;
  initial.observation.neighborhood.basis.levelId = 'old-level';
  const { result, sent } = await invoke(initial);
  assert.equal(result.reason, 'stalePerception');
  assert.equal(sent.length, 0);
});

test('explicit action bound and reasoned exact triage overrides are required', async () => {
  for (const maxActions of [undefined, 0, -1, 1.5, Infinity, 1660]) await assert.rejects(invoke(frame(), undefined, { maxActions }), TypeError);
  for (const override of [true, {}, { reason: '' }, { reason: 'intent', all: true }]) await assert.rejects(invoke(frame(), undefined, { override }), TypeError);
  const initial = frame();
  assert.throws(() => captureWalkTarget(initial, { x: 0, y: 10 }), TypeError);
  assert.ok(Object.isFrozen(captureWalkTarget(initial, destination)));
});

test('storage/recording failures and explicit input gates prevent initial and subsequent input', async () => {
  for (const stage of ['initial', 'response']) {
    for (const source of ['storage', 'recording', 'inputGate']) {
      const initial = frame(), after = returned(initial), chosen = stage === 'initial' ? initial : after;
      chosen[source] = source === 'inputGate' ? { state: 'recoveryRequired' } : { status: 'degraded' };
      const { result, sent } = await invoke(initial, after);
      assert.equal(result.reason, source === 'inputGate' ? 'inputGate' : 'uncertain');
      assert.equal(sent.length, stage === 'initial' ? 0 : 1);
    }
  }
});

test('missing decision and explicitly unavailable perception cannot authorize walking', async () => {
  const initial = frame(); initial.outcome.status = 'needsChoice';
  let attempt = await invoke(initial);
  assert.equal(attempt.result.reason, 'uncertain'); assert.equal(attempt.sent.length, 0);
  initial.outcome.status = 'completed';
  initial.observation.neighborhood = { status: 'unavailable' };
  attempt = await invoke(initial);
  assert.equal(attempt.result.reason, 'inputGate'); assert.equal(attempt.sent.length, 0);
});

test('unsupported assertion added to a selected public schema fails at import', () => {
  const schemaURL = new URL('../../lib/neonethack/protocol/response.schema.json', import.meta.url).href;
  const walkURL = new URL('./walk.mjs', import.meta.url).href;
  const script = `import schema from ${JSON.stringify(schemaURL)} with {type:'json'};
    schema.properties.outcome.minProperties = 2;
    try { await import(${JSON.stringify(walkURL)}); process.exitCode = 1; }
    catch (e) { if (!e.message.includes('Unsupported walk schema keyword: minProperties')) throw e; }`;
  execFileSync(process.execPath, ['--input-type=module', '-e', script]);
});

// Optional read-only audit of ORIGINAL public responses. No archive is copied,
// modified, replayed into an engine, or required by the portable fixture suite.
// NEO42_ARCHIVE=/path/to/neohack-overnight-20260908 node --test .../walk.test.mjs
if (process.env.NEO42_ARCHIVE) {
  const archived = (run, id) => {
    const row = readFileSync(`${process.env.NEO42_ARCHIVE}/${run}/mcp.jsonl`, 'utf8').trim().split('\n').map(JSON.parse)
      .find(r => r.direction === 'response' && r.message.id === id);
    assert.ok(row, `${run} response ${id}`);
    return row.message.result.structuredContent;
  };
  test('original run013 id128 position-only adjacent hostile: no next mutation', async () => {
    const initial = archived('run013', 128);
    assert.ok(initial.creatures.some(c => c.attitude === 'hostile' && c.position && !('distance' in c)));
    const { result, sent } = await invoke(initial);
    assert.equal(result.reason, 'creatureNearby'); assert.equal(sent.length, 0);
  });
  test('original run013 id206→207 weak→fainting: no request 208', async () => {
    const initial = archived('run013', 206), after = archived('run013', 207);
    const { result, sent } = await invoke(initial, after, { maxActions: 50, target: captureWalkTarget(initial, { x: 62, y: 15 }), override: { reason: 'Audit explicitly permits initial weak state', hunger: 'weak' } });
    assert.equal(result.reason, 'hungerChanged'); assert.equal(sent.length, 1);
    assert.equal(result.frame, after);
    assert.deepEqual(result.stops[0], { reason: 'hungerChanged', from: 'weak', to: 'fainting' });
  });
  test('original run015 id63 full-HP foodPoisoned: no request 64', async () => {
    const initial = archived('run015', 63);
    assert.equal(initial.observation.vitals.health, initial.observation.vitals.maxHealth);
    const { result, sent } = await invoke(initial);
    assert.equal(result.reason, 'triage'); assert.equal(sent.length, 0);
    assert.ok(result.stops[0].conditions.includes('foodPoisoned'));
  });
}
