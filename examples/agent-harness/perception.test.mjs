import assert from 'node:assert/strict';
import test from 'node:test';
import { assessProximityThreats, decodePosition } from './perception.mjs';

// Disposable public-shape fixtures. No archived helpers, logs or sessions loaded.
function fixture(source, appearance = 'floating eye', position = { x: 11, y: 10 }) {
  const snapshot = { observation: { you: { x: 10, y: 10 } } };
  if (source === 'world') {
    snapshot.observation.world = [{ ...position, occupant: { kind: 'creature', appearance } }];
  } else {
    snapshot.creatures = [{ appearance, position }];
  }
  return snapshot;
}

const invalidPositions = [undefined, null, {}, { x: 10 }, { y: 10 }, [11, 10],
  '11,10', 11, { x: '11', y: 10 }, { x: 11, y: null }, { x: true, y: 10 },
  { x: NaN, y: 10 }, { x: 11, y: Infinity }, { x: -Infinity, y: 10 },
  { x: 10.5, y: 10 }, { x: 11, y: 9.5 },
  { x: Number.MAX_SAFE_INTEGER + 1, y: 10 },
  { x: 11, y: Number.MIN_SAFE_INTEGER - 1 }];

test('coordinate objects decode values by name, including zero and reverse key order', () => {
  assert.deepEqual(decodePosition({ y: 0, x: 11 }), [11, 0]);
  for (const position of invalidPositions) assert.equal(decodePosition(position), null);
  assert.equal(decodePosition(Object.create({ x: 11, y: 10 })), null);
});

for (const source of ['world', 'creatures']) {
  test(`${source}-only eye is unsafe without a tuple-of-keys crash`, () => {
    const result = assessProximityThreats(fixture(source));
    assert.equal(result.status, 'unsafe');
    assert.equal(result.blocked, true);
    assert.deepEqual(result.threats, [{ source, index: 0, position: [11, 10],
      appearance: 'floating eye', distance: 1, reason: 'nearby-eye-appearance' }]);
    assert.deepEqual(result.unknowns, []);
  });

  test(`${source}: non-eye and distance boundaries use coordinates`, () => {
    for (const [appearance, position, status] of [
      ['newt', { x: 11, y: 10 }, 'clear'],
      ['FLOATING EYE', { x: 12, y: 12 }, 'unsafe'],
      ['floating eye', { x: 7, y: 10 }, 'clear'],
      ['floating eye', { x: 10, y: 7 }, 'clear'],
      ['floating eye', { x: 8, y: 8 }, 'unsafe'],
    ]) {
      const result = assessProximityThreats(fixture(source, appearance, position));
      assert.equal(result.status, status);
      assert.equal(result.blocked, status !== 'clear');
    }
  });

  test(`${source}: missing/null/invalid eye and non-eye coordinates remain unknown`, () => {
    for (const appearance of ['floating eye', 'newt']) {
      for (const position of invalidPositions) {
        const snapshot = fixture(source, appearance);
        if (source === 'world') snapshot.observation.world[0] = { ...position,
          occupant: { kind: 'creature', appearance } };
        else snapshot.creatures[0].position = position;
        const result = assessProximityThreats(snapshot);
        assert.equal(result.status, 'unknown');
        assert.equal(result.blocked, true);
        assert.equal(result.unknowns[0].reason, 'invalid-position');
      }
    }
  });

  test(`${source}: unidentified adjacent creatures remain uncertain, glyphs do not identify`, () => {
    for (const appearance of [null, '', '  ', 42, {}]) {
      const snapshot = fixture(source, appearance);
      const creature = source === 'world' ? snapshot.observation.world[0].occupant : snapshot.creatures[0];
      creature.mark = 'e';
      const result = assessProximityThreats(snapshot);
      assert.equal(result.status, 'unknown');
      assert.equal(result.threats.length, 0);
      assert.equal(result.unknowns[0].reason, 'unknown-nearby-identity');
    }
    const missing = fixture(source);
    delete (source === 'world' ? missing.observation.world[0].occupant : missing.creatures[0]).appearance;
    assert.equal(assessProximityThreats(missing).status, 'unknown');
    assert.equal(assessProximityThreats(fixture(source, null, { x: 12, y: 10 })).status, 'clear');
  });
}

test('both sources contribute; malformed evidence cannot erase a known nearby eye', () => {
  const snapshot = fixture('creatures');
  snapshot.observation.world = fixture('world', 'newt', null).observation.world;
  const result = assessProximityThreats(snapshot);
  assert.equal(result.status, 'unsafe');
  assert.equal(result.blocked, true);
  assert.equal(result.threats.length, 1);
  assert.equal(result.unknowns.length, 1);
});

test('missing hero coordinates and unsafe precision never imply a faraway creature', () => {
  for (const position of invalidPositions) {
    const snapshot = fixture('creatures');
    snapshot.observation.you = position;
    const result = assessProximityThreats(snapshot);
    assert.equal(result.status, 'unknown');
    assert.equal(result.blocked, true);
    assert.equal(result.hero, null);
  }
  const snapshot = fixture('creatures', 'floating eye', { x: -Number.MAX_VALUE, y: 0 });
  const result = assessProximityThreats(snapshot);
  assert.equal(result.status, 'unknown');
  assert.equal(result.blocked, true);
  assert.equal(result.unknowns[0].reason, 'invalid-position');
});

test('missing or malformed perception is explicit uncertainty', () => {
  for (const snapshot of [undefined, null, {}, { observation: { you: { x: 10, y: 10 } } },
    { observation: { you: { x: 10, y: 10 }, world: null } },
    { observation: { you: { x: 10, y: 10 }, world: [] }, creatures: null },
    { observation: { you: { x: 10, y: 10 } }, creatures: [null] },
    { observation: { you: { x: 10, y: 10 }, world: [null] } },
    { observation: { you: { x: 10, y: 10 }, world: [{ occupant: null }] } },
    { observation: { you: { x: 10, y: 10 }, world: [{ occupant: {} }] } }]) {
    assert.equal(assessProximityThreats(snapshot).status, 'unknown');
    assert.equal(assessProximityThreats(snapshot).blocked, true);
  }
});

test('self and unoccupied cells are not creature signals; allies still carry perceived eye signals', () => {
  const snapshot = fixture('world');
  snapshot.observation.world[0].occupant.kind = 'self';
  snapshot.observation.world.push({ x: 10, y: 9, objects: [{ mark: 'e' }] });
  assert.equal(assessProximityThreats(snapshot).status, 'clear');
  snapshot.observation.world[0].occupant.kind = 'ally';
  assert.equal(assessProximityThreats(snapshot).status, 'unsafe');
});

test('raw deltas require reconstruction, empty reconstructed collections are clear', () => {
  const snapshot = { observation: { you: { x: 10, y: 10 }, world: [] }, creatures: [] };
  assert.equal(assessProximityThreats(snapshot).status, 'clear');
  snapshot.update = { kind: 'delta' };
  assert.equal(assessProximityThreats(snapshot).status, 'unknown');
});

test('assessment is deterministic and preserves the public input and standing decision', () => {
  const snapshot = fixture('creatures');
  snapshot.decision = { id: 'fixture-choice', kind: 'confirmation', cancellable: true };
  const before = structuredClone(snapshot);
  const first = assessProximityThreats(snapshot);
  assert.deepEqual(assessProximityThreats(snapshot), first);
  first.hero[0] = 99;
  first.threats[0].position[0] = 99;
  assert.deepEqual(snapshot, before);
});
