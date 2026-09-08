import test from 'node:test';
import assert from 'node:assert/strict';
import { mapLayers, renderMap } from './map.mjs';

// Minimal public cell verified against run016 RPC57, physical line 114.
// Source SHA256: 1e1bbcb8224d25d2b8534e98f7ea81accf652a10607275ea928aa7400ae1f209
// No log, session, receipt, or private state is needed to run these fixtures.
const rpc57Cell = {
  objects: [{ color: 8, kind: 'boulder', mark: '`' }],
  terrain: { freshness: 'remembered', knowledge: 'remembered', type: 'corridor' },
  visible: false, x: 31, y: 13,
};
const observation = world => ({ world, you: null, location: { id: 'fixture-level' } });
const cell = (type, extra = {}) => ({
  x: 1, y: 1, visible: true,
  terrain: { type, freshness: 'current', knowledge: 'remembered' }, ...extra,
});
const neighborhood = cells => ({
  status: 'available', basis: { levelId: 'fixture-level', revision: 2, origin: { x: 1, y: 1 } },
  cells: cells.map(value => ({ inBounds: true, ...value })),
});

test('RPC57 remembered corridor renders its canonical boulder with source layers intact', () => {
  const o = observation([structuredClone(rpc57Cell)]);
  const [record] = mapLayers(o);
  assert.equal(record.glyph, 'O');
  assert.deepEqual(record.world.objects, rpc57Cell.objects);
  assert.deepEqual(record.world.terrain, rpc57Cell.terrain);
  assert.equal(record.world.visibility, 'not visible');
  assert.match(renderMap(o), / 13 O \| m/);
  assert.match(renderMap(o), /world \(31,13\).*"freshness":"remembered"/);
});

test('canonical trap terrain is explicit; unrecognized labels are never guessed', () => {
  for (const [type, expected] of [['trap', '^'], ['trapdoorMystery', '?'], ['arrow trap', '?']]) {
    const o = observation([cell(type)]);
    assert.equal(mapLayers(o)[0].glyph, expected);
    assert.ok(renderMap(o).includes(`"type":"${type}"`));
  }
});

test('objects over stairs retain both objects and the exact staircase layer', () => {
  const objects = [{ mark: '!', color: 4 }, { kind: 'boulder', mark: '`', color: 8 }];
  const o = observation([cell('stairsDown', { objects })]);
  const [record] = mapLayers(o);
  assert.equal(record.glyph, 'O');
  assert.deepEqual(record.world.objects, objects);
  assert.equal(record.world.terrain.type, 'stairsDown');
  assert.match(renderMap(o), /world \(1,1\).*"type":"stairsDown".*"mark":"!".*"kind":"boulder"/);
});

test('ordinary objects use only public marks and do not infer item identity', () => {
  const o = observation([cell('stairsUp', { objects: [{ mark: '!', color: 4 }] })]);
  assert.equal(mapLayers(o)[0].glyph, '!');
  assert.match(renderMap(o), /"type":"stairsUp"/);
  assert.doesNotMatch(renderMap(o), /potion/);
  assert.equal(mapLayers(observation([cell('floor', { items: [{ label: 'obsolete' }] })]))[0].glyph, '.');
  assert.equal(mapLayers(observation([cell('boulder')]))[0].glyph, '?');
});

test('current, remembered and unknown visibility remain distinct from terrain knowledge', () => {
  const remembered = structuredClone(rpc57Cell);
  const current = { ...structuredClone(rpc57Cell), x: 32, visible: true,
    terrain: { ...rpc57Cell.terrain, freshness: 'current' } };
  const uncertain = { ...structuredClone(rpc57Cell), x: 33 };
  delete uncertain.visible;
  delete uncertain.terrain.freshness;
  const o = observation([remembered, current, uncertain]);
  assert.match(renderMap(o), / 13 OOO \| mv\?/);
  const layers = mapLayers(o);
  assert.deepEqual(layers.map(c => c.world.visibility), ['not visible', 'visible', 'unknown']);
  assert.equal(layers[1].world.terrain.knowledge, 'remembered');
  assert.equal(layers[1].world.terrain.freshness, 'current');
  assert.equal(layers[2].world.terrain.freshness, undefined);
  assert.ok(layers.every(c => c.world.objects[0].freshness === undefined));
});

test('neighborhood hazards retain source and basis without changing world terrain', () => {
  const o = observation([cell('stairsUp', { objects: [{ mark: '?', color: 2 }] })]);
  o.neighborhood = neighborhood([cell('stairsUp', { hazards: ['trap', 'water', 'lava'] })]);
  const [record] = mapLayers(o);
  assert.equal(record.glyph, '?');
  assert.equal(record.world.terrain.type, 'stairsUp');
  assert.equal(record.world.hazards, undefined);
  assert.deepEqual(record.neighborhood.hazards, ['trap', 'water', 'lava']);
  assert.deepEqual(record.neighborhood.basis, o.neighborhood.basis);
  assert.match(renderMap(o), /neighborhood \(1,1\).*"hazards":\["trap","water","lava"\]/);
});

test('neighborhood-only cells preserve objects and exclude out-of-bounds entries', () => {
  const o = observation([]);
  o.neighborhood = neighborhood([
    cell('floor', { objects: [{ mark: '`', kind: 'boulder', color: 8 }], hazards: ['trap'] }),
    cell('lava', { x: -1, inBounds: false }),
  ]);
  const layers = mapLayers(o);
  assert.equal(layers.length, 1);
  assert.equal(layers[0].glyph, 'O');
  assert.equal(layers[0].world, undefined);
  assert.deepEqual(layers[0].neighborhood.hazards, ['trap']);
});

test('hero and apparent occupant overlays keep obscured object and terrain descriptions', () => {
  const o = observation([cell('stairsDown', { objects: [{ mark: '!', color: 4 }],
    occupant: { kind: 'creature', mark: 'I', appearance: 'unseen creature' } })]);
  assert.equal(mapLayers(o)[0].glyph, 'M');
  o.you = { x: 1, y: 1 };
  assert.equal(mapLayers(o)[0].glyph, '@');
  assert.match(renderMap(o), /"type":"stairsDown".*"objects":\[.*"appearance":"unseen creature"/);
});

test('rendering is deterministic and does not mutate inputs or share returned layers', () => {
  const o = observation([structuredClone(rpc57Cell)]);
  o.neighborhood = neighborhood([cell('trap', { hazards: ['trap'] })]);
  const original = structuredClone(o);
  assert.equal(renderMap(o), renderMap(o));
  const layers = mapLayers(o);
  layers[0].neighborhood.hazards.push('lava');
  layers[1].world.objects[0].mark = 'X';
  assert.deepEqual(o, original);
});

test('unknown or control object marks cannot inject terminal escapes into the grid', () => {
  const o = observation([cell('floor', { objects: [{ mark: '\u001b[31m', color: 1 }] })]);
  assert.equal(mapLayers(o)[0].glyph, '*');
  assert.ok(!renderMap(o).includes('\u001b'));
  assert.ok(renderMap(o).includes('\\u001b'));
});

test('unavailable neighborhood is explicit and does not use any cells it carries', () => {
  const o = observation([cell('floor')]);
  o.neighborhood = { status: 'unavailable', reason: 'unsupportedPerception', cells: [cell('trap')] };
  assert.equal(mapLayers(o)[0].neighborhood, undefined);
  assert.match(renderMap(o), /neighborhood unavailable: "unsupportedPerception"/);
  o.world = [];
  assert.equal(renderMap(o), 'no world data\nneighborhood unavailable: "unsupportedPerception"');
});

test('missing snapshots, mixed levels and unbounded coordinates fail explicitly', () => {
  assert.throws(() => renderMap({}), /reconstructed public observation/);
  assert.equal(renderMap(observation([])), 'no world data');
  const o = observation([cell('floor')]);
  o.neighborhood = neighborhood([]);
  o.neighborhood.basis.levelId = 'another-level';
  assert.throws(() => renderMap(o), /level must match/);
  assert.throws(() => renderMap(observation([cell('floor', { x: NaN })])), /safe integers/);
  assert.throws(() => renderMap(observation([cell('floor'), cell('floor', { x: 100001 })])), /bounding box/);
});
