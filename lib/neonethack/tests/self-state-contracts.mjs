import { test } from 'node:test';
import assert from 'node:assert/strict';
const hero = { name: 'SelfState', role: 'wizard', race: 'human', gender: 'female', align: 'neutral' };
export function selfStateContracts(label, fixture) {
  for (const [seed, kind, starts, ends] of [[4, 'sleeping', /fall asleep/, /wake up/], [12, 'paralysis', /frozen/, /move again/]]) {
    test(`${label}: real ${kind} advances involuntary turns with ordered disclosed narration`, async t => {
      const { api, transport } = await fixture(t);
      const game = await api.create({ ...hero, seed });
      assert.equal(game.observation.vitals.hunger, 'not_hungry');
      assert.equal(game.observation.vitals.burden, 'unencumbered');
      assert.equal(game.observation.vitals.hungerLabel, '');
      const potion = game.observation.inventory.find(i => i.label.includes(`potion of ${kind}`));
      assert.ok(potion, 'scenario must use an actually perceived potion');
      const before = game.observation.turn;
      const request = { version: 1, method: 'game.drink', params: { sessionId: game.id, requestId: `involuntary-${kind}`, expectedRevision: game.state.revision, item: { id: potion.id } } };
      const result = await transport.send(request);
      assert.equal(result.decision, null);
      assert.equal(result.ended, false);
      assert.ok(result.outcome.turnsElapsed > 1);
      assert.equal(result.outcome.turnsElapsed, result.observation.turn - before);
      const messages = result.events.filter(e => e.type === 'heard').map(e => e.text);
      const start = messages.findIndex(s => starts.test(s)), end = messages.findIndex(s => ends.test(s));
      assert.ok(start >= 0 && end > start, JSON.stringify(messages));
      const turns = result.events.filter(e => e.type === 'felt' && e.sense === 'turn').map(e => Number(e.value));
      assert.ok(turns.length > 1);
      assert.ok(turns.every((n, i) => i === 0 || n >= turns[i - 1]));
      assert.equal(turns.at(-1), result.observation.turn);
      assert.deepEqual(await transport.send(request), result, 'exact receipt replay spends no further turns');
      await game.observe();
      assert.equal(game.observation.neighborhood.inputGate.state, 'ready');
      await game.close();
    });
  }
}
