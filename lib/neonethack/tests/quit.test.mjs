import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, identity } from './native-fixture.mjs';

test('quit requires explicit consent and the ended run survives C resumption', async t => {
  const { api } = await fixture(t);
  let game = await api.create(identity);
  const turn = game.observation.turn;
  let offer = await game.quit();
  assert.equal(offer.decision?.kind, 'confirmation');
  assert.equal(offer.ended, false);
  assert.equal(offer.observation.turn, turn);
  const id = game.id;
  await game.close();
  game = await api.resume(id);
  assert.deepEqual(game.decision, offer.decision);
  const declined = await game.answer(game.decision.id, { kind: 'confirmation', confirm: false });
  assert.equal(declined.ended, false);
  assert.equal(declined.observation.turn, turn);
  offer = await game.quit();
  const ended = await game.answer(offer.decision.id, { kind: 'confirmation', confirm: true });
  assert.equal(ended.ended, true);
  assert.equal(ended.end?.kind, 'quit');
  await game.close();
  game = await api.resume(id);
  assert.equal(game.state.ended, true);
  assert.equal(game.state.end?.kind, 'quit');
});
