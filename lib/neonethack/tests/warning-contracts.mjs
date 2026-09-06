import { test } from 'node:test';
import assert from 'node:assert/strict';
const hero = { name: 'Warning', seed: 42, role: 'valkyrie', race: 'dwarf', gender: 'female', align: 'lawful' };
const directions = new Map([['-1,-1','northwest'],['0,-1','north'],['1,-1','northeast'],['-1,0','west'],['1,0','east'],['-1,1','southwest'],['0,1','south'],['1,1','southeast']]);
async function declineAndReplan(b, game, offer, attempt) {
  assert.equal(offer.decision.kind, 'confirmation');
  assert.deepEqual(offer.observation.neighborhood.inputGate, { state: 'decision', decisionId: offer.decision.id });
  assert.equal(offer.decision.context.action, offer.decision.action);
  const turn = offer.observation.turn;
  await game.close(); game = await b.api.resume(game.id);
  assert.deepEqual(game.decision, offer.decision, 'standing warning and context survive resume');
  const request = { version: 1, method: 'decision.answer', params: { sessionId: game.id, requestId: 'decline-warning', expectedRevision: game.state.revision, decisionId: offer.decision.id, answer: { kind: 'confirmation', confirm: false } } };
  const declined = await b.transport.send(request);
  assert.equal(declined.decision, null);
  assert.equal(declined.outcome.turnsElapsed, 0);
  assert.equal(declined.observation.turn, turn);
  assert.deepEqual(await b.transport.send(request), declined);
  await game.observe();
  assert.equal(game.decision, null, 'observe does not issue another move or warning');
  const inspect = await game.actions('here');
  assert.equal(inspect.inputGate.state, 'ready', 'explicit alternative planning query is not silently redirected');
  const again = await attempt(game);
  assert.equal(again.decision.kind, 'confirmation');
  assert.notEqual(again.decision.id, offer.decision.id, 'deliberate reattempt yields a distinct genuine decision');
  const cancelled = await game.cancel(again.decision.id);
  assert.equal(cancelled.outcome.status, 'cancelled');
  assert.equal(cancelled.decision, null);
  await game.close();
}
export function ordinaryWarningContracts(label, fixture) {
  test(`${label}: real eating warning allows decline without automatic continuation`, async t => {
    const b = await fixture(t), game = await b.api.create({ ...hero, name: 'WarningFood', seed: 4386, role: 'tourist', race: 'human', align: 'neutral' });
    await game.move('west');
    const amulet = game.observation.here.items.find(i => i.category === 'amulet');
    assert.ok(amulet, 'fresh scenario must disclose the actual floor item');
    await game.pickup({id:amulet.id}); await game.wait();
    const food = game.observation.inventory.find(i => i.label.includes('food ration'));
    assert.ok(food);
    await game.eat({id:food.id});
    const offer = await game.eat({id:food.id});
    assert.equal(offer.decision.kind, 'confirmation');
    assert.equal(offer.decision.about, 'Continue eating?');
    assert.deepEqual(offer.decision.context, {action:'eat',itemId:food.id});
    await game.close(); const resumed = await b.api.resume(game.id);
    assert.deepEqual(resumed.decision, offer.decision);
    const declined = await resumed.answer(offer.decision.id, {kind:'confirmation',confirm:false});
    assert.equal(declined.decision, null);
    assert.equal(declined.ended, false);
    assert.ok(!declined.events.some(e => e.type === 'lifeSaved'));
    const turn = declined.observation.turn;
    assert.equal((await resumed.observe()).observation.turn, turn);
    await resumed.close();
  });
  test(`${label}: prayer decline, explicit replan, deliberate retry and cancellation preserve consent`, async t => {
    const b = await fixture(t), game = await b.api.create(hero);
    const offer = await game.pray();
    assert.deepEqual(offer.decision.context, { action: 'pray' });
    await declineAndReplan(b, game, offer, g => g.pray());
  });
  test(`${label}: a study warning retains only the explicit item id`, async t => {
    const b = await fixture(t), game = await b.api.create({ ...hero, role: 'wizard', race: 'human', align: 'neutral', seed: 6 });
    const book = game.observation.inventory.find(i => i.label.includes('spellbook of force bolt'));
    assert.ok(book);
    const offer = await game.read({ id: book.id });
    assert.equal(offer.decision.about, 'Refresh your memory anyway?');
    assert.deepEqual(offer.decision.context, { action: 'read', itemId: book.id });
    await declineAndReplan(b, game, offer, g => g.read({id:book.id}));
  });
  test(`${label}: item selection can lead to a new warning without implicit consent`, async t => {
    const b = await fixture(t), game = await b.api.create({ ...hero, role: 'wizard', race: 'human', align: 'neutral', seed: 6 });
    const selection = await game.read();
    assert.equal(selection.decision.kind, 'item');
    const book = selection.decision.options.find(i => i.label.includes('spellbook of force bolt'));
    assert.ok(book);
    const warning = await game.answer(selection.decision.id, {kind:'item',item:{id:book.id}});
    assert.equal(warning.decision.kind, 'confirmation');
    assert.notEqual(warning.decision.id, selection.decision.id);
    assert.deepEqual(warning.decision.context, {action:'read'}, 'initial unspecified item is not reconstructed from a slot');
    const declined = await game.answer(warning.decision.id, {kind:'confirmation',confirm:false});
    assert.equal(declined.decision, null);
    assert.equal(declined.outcome.turnsElapsed, 0);
    await game.close();
  });
}
export function controlledWarningContracts(label, fixture) {
  for (const mode of ['Trap','Peaceful']) test(`${label}: actual ${mode.toLowerCase()} warning can be declined and deliberately revisited`, async t => {
    const b = await fixture(t), game = await b.api.create({...hero, name:`Warning${mode}`});
    const cell = game.observation.neighborhood.cells.find(c => c.movement.relation === 'adjacent' && (mode === 'Trap' ? c.hazards?.includes('trap') : c.occupant?.appearance === 'grid bug'));
    assert.ok(cell, 'controlled world must disclose its actual target');
    const direction = directions.get(`${cell.dx},${cell.dy}`);
    const offer = await game.move(direction);
    assert.match(offer.decision.about, mode === 'Trap' ? /squeaky board/ : /Really attack/);
    assert.deepEqual(offer.decision.context, { action: 'move', direction });
    await declineAndReplan(b, game, offer, g => g.move(direction));
  });
}
