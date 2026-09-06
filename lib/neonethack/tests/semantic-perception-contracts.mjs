import assert from 'node:assert/strict';
import { test } from 'node:test';

export function assertPerceivedOccupants(observation) {
  const neighborhood = observation.neighborhood;
  assert.equal(neighborhood.status, 'available');
  assert.equal(neighborhood.cells.length, 81);
  for (const cell of neighborhood.cells) {
    const world = observation.world.find(w => w.x === cell.x && w.y === cell.y);
    assert.equal(cell.occupant?.kind, world?.occupant?.kind,
      `same displayed occupant at ${cell.x},${cell.y}: ${JSON.stringify({ cell, world })}`);
    if (!world) assert.notEqual(cell.movement.intent, 'creatureBump');
    if (world) {
      assert.deepEqual(cell.occupant, world.occupant, 'shared displayed occupant facts');
      assert.deepEqual(cell.objects, world.objects, 'shared displayed object facts');
      if (world.terrain.type === 'trap') assert.ok(cell.hazards.includes('trap'));
      else assert.equal(cell.terrain.type, world.terrain.type);
      assert.equal(cell.terrain.freshness, world.terrain.freshness);
    }
  }
}

export function semanticPerceptionContracts(label, fixture) {
  test(`${label}: fresh empty cells never fabricate neighborhood creatures`, async t => {
    const { api } = await fixture(t);
    const game = await api.create({ name: 'Perception', seed: 42, role: 'rogue', race: 'human', gender: 'female', align: 'chaotic' });
    assertPerceivedOccupants(game.observation);
    for (const direction of ['north','northeast','east','southeast','south','southwest','west','northwest']) {
      const result = await game.actions({direction});
      assert.deepEqual(result.cell, game.observation.neighborhood.cells.find(c => c.x === result.cell.x && c.y === result.cell.y));
    }
    await game.search();
    assertPerceivedOccupants(game.observation);
    await game.close();
  });
  test(`${label}: items over floor and remembered room facts agree across views`, async t => {
    const { api } = await fixture(t);
    const game = await api.create({ name: 'Layers', seed: 42, role: 'valkyrie', race: 'dwarf', gender: 'female', align: 'lawful' });
    assert.ok(game.observation.world.some(c => c.objects?.length));
    assertPerceivedOccupants(game.observation);
    for (const direction of ['south','south','west','west']) await game.move(direction);
    await game.open('south');
    await game.move('south'); await game.move('south');
    const remembered = game.observation.world.filter(c => !c.visible && c.terrain.type === 'floor');
    assert.ok(remembered.length > 5);
    assert.ok(remembered.every(c => c.terrain.freshness === 'remembered'));
    assertPerceivedOccupants(game.observation);
    const corridors = game.observation.world.filter(c => c.visible && c.terrain.type === 'corridor');
    assert.ok(corridors.length >= 2, 'actual corridor cells must be in sight, not just remembered room floors');
    assert.ok(corridors.every(c => c.terrain.freshness === 'current'));
    assert.equal((await game.actions('here')).cell.terrain.type, 'corridor');
    await game.move('north'); await game.move('north');
    const outOfSight = corridors.map(old => game.observation.world.find(c => c.x === old.x && c.y === old.y));
    assert.ok(outOfSight.every(c => c && !c.visible && c.terrain.type === 'corridor' && c.terrain.freshness === 'remembered'),
      'leaving the dark corridor preserves known corridor terrain despite loss of sight');
    assertPerceivedOccupants(game.observation);
    for (const cell of outOfSight) {
      const local = game.observation.neighborhood.cells.find(c => c.x === cell.x && c.y === cell.y);
      assert.ok(local, 'remembered corridor must actually remain in the tested local view');
      assert.equal(local.visible, false); assert.equal(local.terrain.freshness, 'remembered');
    }
    await game.move('south'); await game.move('south');
    for (const old of corridors) {
      const restored = game.observation.world.find(c => c.x === old.x && c.y === old.y);
      assert.equal(restored.visible, true); assert.equal(restored.terrain.freshness, 'current');
    }
    assertPerceivedOccupants(game.observation);
    await game.close();
  });
}
