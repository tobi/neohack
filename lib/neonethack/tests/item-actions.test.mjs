import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './native-fixture.mjs';

test('per-item actions agree with real C candidate decisions, including worn equipment', async t => {
  const { api } = await fixture(t);
  const game = await api.create({name: 'Backpack', seed: 42, role: 'wizard', race: 'human', gender: 'female', align: 'neutral'});
  for (const action of ['eat', 'equip', 'remove', 'apply', 'drink', 'read', 'zap', 'wield', 'drop']) {
    const before = game.observation;
    const candidates = [...before.inventory, ...before.here.items].filter(item => item.actions?.includes(action));
    const result = await game[action]().catch(error => { if (error.response?.error?.code !== "unavailable") throw error; return error.response; });
    assert.equal(result.observation.turn, before.turn, action + ' candidate discovery is free');
    if (candidates.length) {
      assert.equal(result.decision?.kind, 'item', action);
      const expected = candidates.map(item => item.id);
      if (action === 'wield') expected.push('hands'); // explicit engine no-item choice
      assert.deepEqual(result.decision.options.map(item => item.id).sort(), expected.sort(), action);
      await game.cancel(result.decision.id);
    } else {
      assert.equal(result.decision, null, action);
      assert.equal(result.outcome.status, 'blocked', action);
    }
  }
  const worn = game.observation.inventory.find(item => item.actions.includes('remove'));
  assert.ok(worn);
  assert.equal(worn.actions.includes('equip'), false);
  const result = await game.remove({id: worn.id});
  assert.equal(result.error, undefined);
  const removed = game.observation.inventory.find(item => item.id === worn.id);
  assert.ok(removed.actions.includes('equip'));
  assert.equal(removed.actions.includes('remove'), false);
});
