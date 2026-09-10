import { test } from 'node:test';
import assert from 'node:assert/strict';

export function doorOrientationContracts(name, fixture) {
  for (const [seed, race, orientation, path, direction] of [
    [42, 'dwarf', 'horizontal', ['south', 'south', 'west', 'west'], 'south'],
    [24, 'human', 'vertical', Array(8).fill('east'), 'east'],
  ]) test(`${name}: disclosed ${orientation} door frame survives observation and resume`, async t => {
    const backend = await fixture(t);
    let game = await backend.api.create({ name: 'Orientation', seed, role: 'valkyrie', race, gender: 'female', align: 'lawful' });
    for (const step of path) await game.move(step);
    const query = await game.actions({ direction });
    assert.equal(query.cell.terrain.type, 'closedDoor');
    assert.equal(query.cell.terrain.orientation, orientation);
    const { x, y } = query.cell;
    const worldDoor = () => game.observation.world.find(c => c.x === x && c.y === y);
    assert.equal(worldDoor().terrain.orientation, orientation);
    assert.equal(game.observation.neighborhood.cells.find(c => c.x === x && c.y === y).terrain.orientation, orientation);
    assert.ok(game.observation.world.every(c => ['openDoor', 'closedDoor'].includes(c.terrain.type) || !('orientation' in c.terrain)));
    if (seed === 42) {
      const offer = await game.open();
      await game.answer(offer.decision.id, { kind: 'target', target: { direction } });
      assert.equal(worldDoor().terrain.type, 'openDoor');
      assert.equal(worldDoor().terrain.orientation, orientation);
      await game.move(direction);
      assert.equal(worldDoor().terrain.orientation, orientation, 'underfoot disclosure retains the frame axis');
      await game.move(direction);
    }
    const before = game.observation;
    if (backend.restart) {
      game = await backend.restart(game);
      assert.deepEqual(game.observation, before);
      assert.equal(worldDoor().terrain.orientation, orientation);
    }
  });
}
