// Actual visible threats interrupt ordinary meals/study. No hidden-state
// fixtures, terminal commands, debug inventory or fabricated observations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const results = frame => frame.events.filter(e => e.type === 'actionResult');
export function interruptionContracts(name, fixture) {
  test(`${name}: an engine refusal to wait in danger is blocked, not a completed turn or resumed meal`, async t => {
    const b = await fixture(t), game = await b.api.create({ name: 'Wait', role: 'valkyrie', seed: 10, race: 'human', gender: 'female', align: 'lawful' });
    const food = game.observation.inventory.find(i => i.label.includes('food ration')); assert.ok(food);
    assert.equal((await game.eat({ id: food.id })).outcome.status, 'interrupted');
    const before = game.observation;
    const result = await game.wait();
    assert.equal(result.outcome.status, 'blocked'); assert.equal(result.outcome.reason, 'noProgress');
    assert.equal(result.outcome.turnsElapsed, 0); assert.equal(result.observation.turn, before.turn);
    assert.deepEqual(result.observation.inventory, before.inventory); assert.deepEqual(results(result), []);
    assert.equal(result.decision, null);
  });
  for (const [action, role, seed, label, fullTurns, interruptedTurns] of [
    ['read', 'wizard', 6, 'spellbook of force bolt', 4, 2],
    ['eat', 'valkyrie', 6, 'food ration', 6, 4],
  ]) test(`${name}: interrupted ${action} retains progress without automatic continuation or duplicate receipts`, async t => {
    const b = await fixture(t);
    let game = await b.api.create({ name: 'Interrupt', role, seed, race: 'human', gender: 'female', align: role === 'wizard' ? 'neutral' : 'lawful' });
    assert.ok(game.observation.world.some(c => c.occupant?.kind === 'creature'), 'The threat must actually be perceived');
    const item = game.observation.inventory.find(i => i.label.includes(label)); assert.ok(item);
    let method = 'game.eat', args = { item: { id: item.id } };
    if (action === 'read') {
      const offer = await game.read({ id: item.id });
      assert.equal(offer.decision.kind, 'confirmation'); assert.equal(offer.decision.about, 'Refresh your memory anyway?');
      game = await b.restart(game); assert.deepEqual(game.decision, offer.decision);
      method = 'decision.answer'; args = { decisionId: game.decision.id, answer: { kind: 'confirmation', confirm: true } };
    }
    const request = { version: 1, method, params: { sessionId: game.id, requestId: 'interrupted-once', expectedRevision: game.state.revision, ...args } };
    const interrupted = await b.transport.send(request); await game.observe();
    assert.equal(interrupted.error, undefined); assert.equal(interrupted.outcome.status, 'interrupted');
    assert.equal(interrupted.outcome.reason, 'activityStopped'); assert.equal(interrupted.outcome.turnsElapsed, interruptedTurns);
    assert.equal(interrupted.decision, null); assert.equal(interrupted.ended, false);
    assert.deepEqual(results(interrupted).map(e => [e.action, e.status]), [[action, 'interrupted']]);
    assert.ok(interrupted.outcome.effects.includes('activityInterrupted'));
    assert.equal(interrupted.outcome.effects.includes('consumedItem'), false);
    const journal = async () => b.sessions ? await readFile(`${b.sessions}/${game.id}/input.log.jsonl`) : null;
    const before = await journal();
    game = await b.restart(game); assert.deepEqual(game.observation, interrupted.observation);
    assert.deepEqual(await b.transport.send(request), interrupted); assert.deepEqual(await journal(), before);
    const waited = await game.wait();
    assert.equal(waited.outcome.turnsElapsed, 1); assert.deepEqual(results(waited), []);
    const remaining = game.observation.inventory.find(i => action === 'eat' ? i.label.includes('partly eaten food ration') : i.id === item.id);
    assert.ok(remaining, 'Rest/resume must not finish or replace the interrupted item');
    // A NEW explicit read/eat, not replay of the initiating request, continues
    // the original engine activity. It must retain already-completed work.
    const continued = { version: 1, method: `game.${action}`, params: { sessionId: game.id, requestId: 'continue-explicitly', expectedRevision: game.state.revision, item: { id: remaining.id } } };
    const completed = await b.transport.send(continued); await game.observe();
    assert.equal(completed.error, undefined); assert.equal(completed.decision, null); assert.equal(completed.outcome.status, 'completed');
    assert.ok(completed.outcome.turnsElapsed > 0 && completed.outcome.turnsElapsed < fullTurns);
    assert.deepEqual(results(completed).map(e => [e.action, e.status]), [[action, 'completed']]);
    if (action === 'eat') assert.equal(completed.observation.inventory.some(i => i.id === remaining.id), false);
    const after = await journal(); game = await b.restart(game);
    assert.deepEqual(game.observation, completed.observation); assert.deepEqual(await b.transport.send(continued), completed);
    assert.deepEqual(await journal(), after);
  });
}
