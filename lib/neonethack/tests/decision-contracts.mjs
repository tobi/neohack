// Public gameplay only: reject invalid answers without losing the actual
// standing choice. A historical error receipt remains historical, not current.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const hero = { name: 'Errors', seed: 42, role: 'wizard', race: 'human', gender: 'female', align: 'neutral' };
export function decisionContracts(name, fixture) {
  for (const kind of ['item', 'confirmation', 'choice']) test(`${name}: ${kind} rejection frames preserve the standing decision and exact old receipts`, async t => {
    const b = await fixture(t);
    let game = await b.api.create(hero);
    const offer = kind === 'item' ? await game.drink('healing') : kind === 'confirmation' ? await game.pray() : await game.equip({ id: game.observation.inventory.find(i => i.category === 'ring').id });
    assert.equal(offer.decision.kind, kind);
    const journal = () => b.sessions ? readFile(`${b.sessions}/${game.id}/input.log.jsonl`) : null;
    const history = await journal();
    const answer = (requestId, value, extra = {}) => ({ version: 1, method: 'decision.answer', params: { sessionId: game.id, requestId, expectedRevision: game.state.revision, decisionId: offer.decision.id, answer: value, ...extra } });
    const requests = [
      [answer('wrong-kind', { kind: 'text', text: 'not this choice' }), 'invalidAnswer'],
      [answer('expired', { kind: 'confirmation', confirm: false }, { decisionId: 'decision-expired' }), 'staleDecision'],
      [{ version: 1, method: 'game.wait', params: { sessionId: game.id, requestId: 'wrong-revision', expectedRevision: game.state.revision + 1 } }, 'staleRevision'],
    ];
    if (kind === 'item') {
      requests.push([answer('wrong-category', { kind: 'item', item: { id: game.observation.inventory.find(i => i.category === 'weapon').id } }), 'staleReference']);
      requests.push([answer('missing-id', { kind: 'item', item: { id: 'item-not-known' } }), 'staleReference']);
      requests.push([answer('missing-name', { kind: 'item', item: 'nonexistent potion' }), 'noMatch']);
    } else {
      requests.push([{ version: 1, method: 'game.wait', params: { sessionId: game.id, requestId: 'pending', expectedRevision: game.state.revision } }, 'pendingDecision']);
      if (kind === 'choice') requests.push([answer('missing-choice', { kind: 'choice', choose: [999999] }), 'invalidAnswer']);
    }
    const receipts = [];
    for (const [request, code] of requests) {
      const result = await b.transport.send(request);
      assert.equal(result.error.code, code); assert.deepEqual(result.decision, offer.decision);
      assert.equal(result.revision, offer.revision); assert.equal(result.outcome.turnsElapsed, 0);
      assert.deepEqual(result.observation, offer.observation); assert.deepEqual(await journal(), history);
      assert.deepEqual(await b.transport.send(request), result);
      // staleRevision fails before reservation; the other invalid answers are
      // durable receipts and must not be recomputed as the world changes.
      if (code !== 'staleRevision') receipts.push([request, result]);
    }
    const conflict = structuredClone(requests[0][0]); conflict.params.answer = { kind: 'confirmation', confirm: true };
    const rejected = await b.transport.send(conflict);
    assert.equal(rejected.error.code, 'requestConflict'); assert.deepEqual(rejected.decision, offer.decision);
    game = await b.restart(game); assert.deepEqual(game.decision, offer.decision); assert.deepEqual(await journal(), history);
    for (const [request, result] of receipts) assert.deepEqual(await b.transport.send(request), result);
    await game.cancel(game.decision.id); assert.equal(game.decision, null);
    const now = game.state, after = await journal();
    for (const [request, result] of receipts) assert.deepEqual(await b.transport.send(request), result);
    assert.deepEqual(await journal(), after);
    assert.deepEqual((await game.observe()).observation, now.observation); assert.equal(game.decision, null);
    game = await b.restart(game);
    for (const [request, result] of receipts) assert.deepEqual(await b.transport.send(request), result);
    assert.equal(game.decision, null);
    await game.close();
    const retired = await b.api.request('decision.cancel', { sessionId: game.id, requestId: 'retired', expectedRevision: game.state.revision, decisionId: offer.decision.id });
    assert.ok(retired.error); assert.equal(retired.decision, null, 'An unloaded/retired world must not manufacture a choice');
  });
}
