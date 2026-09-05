// Ordinary native seeded play (the native/WASM maps are intentionally not
// identical). No debug inventory or private game-state fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture } from './native-fixture.mjs';
const identity = { seed: 4386, name: 'Lifesaving', role: 'tourist', race: 'human', gender: 'female', align: 'neutral' };
const lifeSaved = frame => frame.events.filter(e => e.type === 'lifeSaved');
async function stage(api, wear = true) {
  const game = await api.create(identity);
  await game.move('west');
  const floor = game.observation.here.items.find(i => i.category === 'amulet');
  assert.ok(floor, 'Seeded amulet must actually be perceived');
  await game.pickup({ id: floor.id });
  const amulet = game.observation.inventory.find(i => i.category === 'amulet');
  assert.ok(amulet);
  if (wear) await game.equip({ id: amulet.id }); else await game.wait();
  const food = game.observation.inventory.find(i => i.category === 'food' && i.label.includes('food ration'));
  assert.ok(food);
  const first = await game.eat({ id: food.id }); assert.equal(first.decision, null);
  const warning = await game.eat({ id: food.id });
  assert.equal(warning.decision.kind, 'confirmation'); assert.equal(warning.decision.action, 'eat');
  assert.equal(warning.decision.about, 'Continue eating?');
  return { game, amulet, warning };
}
test('real lifesaving averts choking, consumes only the amulet, and remains alive across exact retry/cold restart', async t => {
  const a = await fixture(t);
  let { game, amulet, warning } = await stage(a.api);
  const log = `${a.sessions}/${game.id}/input.log.jsonl`, before = await readFile(log);
  await a.transport.close();
  const b = await fixture(t, { sessions: a.sessions }); game = await b.api.resume(game.id);
  assert.deepEqual(game.decision, warning.decision); assert.deepEqual(await readFile(log), before);
  const request = { version: 1, method: 'decision.answer', params: { sessionId: game.id, requestId: 'survived-once', expectedRevision: game.state.revision, decisionId: game.decision.id, answer: { kind: 'confirmation', confirm: true } } };
  const result = await b.transport.send(request);
  assert.equal(result.error, undefined); assert.equal(result.ended, false); assert.equal(result.end, null);
  assert.equal(result.decision, null); assert.ok(result.observation.vitals.health > 0);
  assert.equal(result.observation.inventory.some(i => i.id === amulet.id), false);
  assert.equal(lifeSaved(result).length, 1); assert.equal(lifeSaved(result)[0].cause, 'choking');
  assert.equal(result.events.some(e => e.type === 'ended'), false);
  const after = await readFile(log);
  assert.deepEqual(await b.transport.send(request), result); assert.deepEqual(await readFile(log), after);
  await b.transport.close();
  const c = await fixture(t, { sessions: a.sessions }); game = await c.api.resume(game.id);
  assert.deepEqual(game.observation, result.observation);
  assert.deepEqual(await c.transport.send(request), result); assert.deepEqual(await readFile(log), after);
  const next = await game.wait(); assert.equal(next.observation.turn, result.observation.turn + 1); assert.equal(lifeSaved(next).length, 0);
});
test('the same unworn amulet does not avert death; terminal result and receipt survive cold restart', async t => {
  const a = await fixture(t), { game, amulet } = await stage(a.api, false);
  const request = { version: 1, method: 'decision.answer', params: { sessionId: game.id, requestId: 'fatal-once', expectedRevision: game.state.revision, decisionId: game.decision.id, answer: { kind: 'confirmation', confirm: true } } };
  const result = await a.transport.send(request);
  assert.equal(result.error, undefined); assert.equal(result.ended, true); assert.equal(result.end.kind, 'death');
  assert.equal(result.end.cause, 'choked on a food ration'); assert.equal(result.observation.vitals.health, 0);
  assert.equal(lifeSaved(result).length, 0); assert.equal(result.observation.inventory.some(i => i.id === amulet.id), true);
  const path = `${a.sessions}/${game.id}/input.log.jsonl`, before = await readFile(path);
  await a.transport.close(); const b = await fixture(t, { sessions: a.sessions });
  const restored = await b.api.resume(game.id);
  assert.equal(restored.state.ended, true); assert.deepEqual(restored.state.end, result.end);
  assert.deepEqual(await b.transport.send(request), result);
  await assert.rejects(restored.wait()); assert.deepEqual(await readFile(path), before);
});
test('declining the real choking warning neither consumes an amulet nor fabricates rescue', async t => {
  const { api } = await fixture(t), { game, amulet } = await stage(api);
  const result = await game.answer(game.decision.id, { kind: 'confirmation', confirm: false });
  assert.equal(result.ended, false); assert.equal(result.end, null); assert.equal(lifeSaved(result).length, 0);
  assert.ok(game.observation.inventory.find(i => i.id === amulet.id).usage.includes('worn'));
});
