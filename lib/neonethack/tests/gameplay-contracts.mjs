// Real public API scenarios shared by native and WASM. No engine debug mode,
// injected inventory, hidden map access, terminal commands or legacy adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const hero = { name: 'Equipment', seed: 42, role: 'wizard', race: 'human', gender: 'female', align: 'neutral' };
const valkyrie = { ...hero, name: 'Menu', role: 'valkyrie', race: 'dwarf', align: 'lawful' };
const item = (game, category) => { const value = game.observation.inventory.find(i => i.category === category); assert.ok(value, `Missing perceived ${category}`); return value; };
const worn = (game, id) => game.observation.inventory.find(i => i.id === id)?.usage.includes('worn');
async function putRing(game, ring, hand = 'Right') {
  const offer = await game.equip({ id: ring.id });
  if (offer.decision) {
    assert.equal(offer.decision.kind, 'choice');
    assert.deepEqual(offer.decision.options.map(o => o.label).sort(), ['Left', 'Right']);
    await game.answer(offer.decision.id, { kind: 'choice', choose: [offer.decision.options.find(o => o.label === hand).id] });
  }
  assert.equal(worn(game, ring.id), true);
}
async function floor(game) {
  for (const name of ['food ration', 'dagger']) {
    const value = game.observation.inventory.find(i => i.label.includes(name));
    assert.ok(value); await game.drop({ id: value.id });
  }
  assert.equal(game.observation.here.items.length, 2);
}
export function gameplayContracts(name, fixture) {
  test(`${name}: leaving a room retains terrain memory with engine sight, including after resume`, async t => {
    const b = await fixture(t);
    let game = await b.api.create(valkyrie);
    const initial = game.observation;
    assert.ok(initial.world.every(cell => typeof cell.visible === 'boolean'));
    assert.ok(initial.world.filter(cell => !['dark', 'unknown'].includes(cell.terrain.type)).length < 200, 'unexplored layout stays unknown');
    for (const direction of ['south', 'south', 'west', 'west']) await game.move(direction);
    const door = game.observation.world.find(cell => cell.x === game.observation.you.x && cell.y === game.observation.you.y + 1);
    assert.equal(door.terrain.type, 'closedDoor');
    const offer = await game.open();
    await game.answer(offer.decision.id, { kind: 'target', target: { direction: 'south' } });
    await game.move('south'); await game.move('south');
    const remembered = game.observation.world.filter(cell => cell.visible === false && cell.terrain.type === 'floor');
    assert.ok(remembered.length > 5, 'floors behind the door remain known while out of sight');
    const original = initial.world.find(cell => remembered.some(old => old.x === cell.x && old.y === cell.y && old.terrain.type === cell.terrain.type));
    assert.ok(original && original.visible);
    const beforeResume = game.observation;
    if (b.restart) {
      game = await b.restart(game);
      assert.deepEqual(game.observation, beforeResume);
    }
    await game.move('north'); await game.move('north');
    assert.equal(game.observation.world.find(cell => cell.x === original.x && cell.y === original.y).visible, true);
  });
  test(`${name}: an ambiguous perceived name never consumes the first candidate or a wrong-category substitute`, async t => {
    const b = await fixture(t);
    let game = await b.api.create(hero);
    const before = game.observation;
    const potions = before.inventory.filter(i => i.category === 'potion' && i.label.includes('healing'));
    assert.equal(potions.length, 2);
    const offer = await game.drink('healing');
    assert.equal(offer.decision.kind, 'item'); assert.equal(offer.outcome.turnsElapsed, 0);
    for (const potion of potions) assert.ok(offer.decision.options.some(i => i.id === potion.id));
    assert.ok(offer.decision.options.every(i => before.inventory.some(p => p.id === i.id && p.category === 'potion')));
    assert.deepEqual(offer.observation.inventory, before.inventory);
    game = await b.restart(game); assert.deepEqual(game.decision, offer.decision);
    const wrong = await b.api.request('decision.answer', { sessionId: game.id, requestId: 'wrong-category', expectedRevision: game.state.revision, decisionId: game.decision.id, answer: { kind: 'item', item: { id: before.inventory.find(i => i.category === 'weapon').id } } });
    assert.equal(wrong.error.code, 'staleReference'); assert.deepEqual(wrong.decision, offer.decision);
    await game.observe(); assert.deepEqual(game.decision, offer.decision);
    assert.deepEqual(game.observation.inventory, before.inventory);
    await game.cancel(game.decision.id);
    assert.equal(game.observation.turn, before.turn); assert.deepEqual(game.observation.inventory, before.inventory);
    const selected = potions.find(i => !i.label.includes('extra healing'));
    const next = await game.drink('healing');
    const result = await game.answer(next.decision.id, { kind: 'item', item: { id: selected.id } });
    assert.equal(result.outcome.turnsElapsed, 1); assert.equal(result.decision, null);
    assert.equal(result.observation.inventory.some(i => i.id === selected.id), false);
    for (const p of before.inventory.filter(i => i.category === 'potion' && i.id !== selected.id)) assert.ok(result.observation.inventory.some(i => i.id === p.id));
  });
  test(`${name}: escape requires explicit consent and stays terminal after engine restart`, async t => {
    const backend = await fixture(t);
    let game = await backend.api.create(valkyrie);
    const warning = await game.climb('up'); assert.equal(warning.decision.kind, 'confirmation');
    await game.cancel(warning.decision.id);
    assert.equal(game.state.ended, false); assert.equal(game.state.end, null);
    const again = await game.climb('up');
    const request = { version: 1, method: 'decision.answer', params: { sessionId: game.id, requestId: 'escape-once', expectedRevision: game.state.revision, decisionId: again.decision.id, answer: { kind: 'confirmation', confirm: true } } };
    const escaped = await backend.transport.send(request); await game.observe();
    assert.equal(escaped.error, undefined); assert.equal(escaped.ended, true); assert.equal(escaped.end.kind, 'escaped');
    assert.ok(escaped.observation.vitals.health > 0); assert.equal(escaped.decision, null);
    await game.close(); // the engine may already be retired after a terminal fact
    game = await backend.restart(game);
    assert.deepEqual(game.state.end, escaped.end); assert.deepEqual(game.observation, escaped.observation);
    assert.deepEqual(await backend.transport.send(request), escaped);
    await assert.rejects(game.wait());
  });
  test(`${name}: ring removal preserves other equipment and exact receipts after engine restart`, async t => {
    const backend = await fixture(t);
    let game = await backend.api.create(hero);
    const ring = item(game, 'ring'), cloak = item(game, 'armor');
    await putRing(game, ring);
    const request = { version: 1, method: 'game.remove', params: { sessionId: game.id, requestId: 'ring-off', expectedRevision: game.state.revision, item: { id: ring.id } } };
    const result = await backend.transport.send(request); await game.observe();
    assert.equal(result.error, undefined); assert.equal(result.outcome.turnsElapsed, 1);
    assert.equal(worn(game, ring.id), false); assert.equal(worn(game, cloak.id), true);
    assert.deepEqual(await backend.transport.send(request), result);
    game = await backend.restart(game);
    assert.deepEqual(game.observation, result.observation);
    assert.deepEqual(await backend.transport.send(request), result);
  });
  test(`${name}: synthetic equipment selection and genuine hand choice retain the original intent`, async t => {
    const backend = await fixture(t);
    let game = await backend.api.create(hero);
    const ring = item(game, 'ring'), cloak = item(game, 'armor');
    const selection = await game.equip();
    assert.equal(selection.decision.kind, 'item');
    game = await backend.restart(game); assert.deepEqual(game.decision, selection.decision);
    const hand = await game.answer(game.decision.id, { kind: 'item', item: { id: ring.id } });
    assert.equal(hand.decision.kind, 'choice');
    game = await backend.restart(game); assert.deepEqual(game.decision, hand.decision);
    const result = await game.answer(game.decision.id, { kind: 'choice', choose: [game.decision.options.find(o => o.label === 'Left').id] });
    assert.equal(result.outcome.turnsElapsed, 1);
    assert.equal(worn(game, ring.id), true); assert.equal(worn(game, cloak.id), true);
  });
  test(`${name}: cancellation and invalid equipment cannot select substitutes`, async t => {
    const backend = await fixture(t), game = await backend.api.create(hero);
    const rings = game.observation.inventory.filter(i => i.category === 'ring'), cloak = item(game, 'armor');
    const turn = game.observation.turn;
    await assert.rejects(game.remove({ id: rings[0].id }));
    await assert.rejects(game.equip({ id: cloak.id }));
    const hand = await game.equip({ id: rings[0].id });
    await game.cancel(hand.decision.id);
    assert.equal(game.observation.turn, turn); assert.equal(worn(game, rings[0].id), false);
    await putRing(game, rings[0]); await putRing(game, rings[1]);
    await game.remove({ id: rings[1].id });
    assert.equal(worn(game, rings[0].id), true); assert.equal(worn(game, rings[1].id), false); assert.equal(worn(game, cloak.id), true);
  });
  test(`${name}: armor occupations cost five turns and never repeat on retry/resume`, async t => {
    const backend = await fixture(t);
    let game = await backend.api.create({ ...hero, name: 'Armor', role: 'samurai', align: 'lawful' });
    const armor = item(game, 'armor');
    const removed = await game.remove({ id: armor.id });
    assert.equal(removed.outcome.turnsElapsed, 5); assert.equal(worn(game, armor.id), false);
    const request = { version: 1, method: 'game.equip', params: { sessionId: game.id, requestId: 'armor-once', expectedRevision: game.state.revision, item: { id: armor.id } } };
    const equipped = await backend.transport.send(request); await game.observe();
    assert.equal(equipped.error, undefined); assert.equal(equipped.outcome.turnsElapsed, 5);
    assert.equal(worn(game, armor.id), true);
    game = await backend.restart(game);
    assert.deepEqual(game.observation, equipped.observation);
    assert.deepEqual(await backend.transport.send(request), equipped);
  });
  test(`${name}: targeted pickup binds identities, rejects stale references and keeps receipts`, async t => {
    const backend = await fixture(t);
    let game = await backend.api.create(valkyrie); await floor(game);
    const food = game.observation.here.items.find(i => i.category === 'food');
    const request = { version: 1, method: 'game.pickup', params: { sessionId: game.id, requestId: 'pick-once', expectedRevision: game.state.revision, item: { id: food.id } } };
    const result = await backend.transport.send(request); await game.observe();
    assert.equal(result.error, undefined); assert.equal(result.outcome.turnsElapsed, 1);
    assert.equal(game.observation.here.items.length, 1); assert.equal(game.observation.here.items[0].category, 'weapon');
    await assert.rejects(game.pickup({ id: food.id }));
    game = await backend.restart(game);
    assert.deepEqual(game.observation, result.observation);
    assert.deepEqual(await backend.transport.send(request), result);
  });
  test(`${name}: pickup menu excludes headers, resumes, rejects nonexistent choices and supports explicit multiple selection`, async t => {
    const backend = await fixture(t);
    let game = await backend.api.create(valkyrie); await floor(game);
    let offer = await game.pickup();
    assert.equal(offer.decision.kind, 'choice'); assert.equal(offer.decision.options.length, 2);
    const turn = game.observation.turn;
    game = await backend.restart(game); assert.deepEqual(game.decision, offer.decision);
    const bad = await backend.api.request('decision.answer', { sessionId: game.id, requestId: 'header', expectedRevision: game.state.revision, decisionId: game.decision.id, answer: { kind: 'choice', choose: [0] } });
    assert.equal(bad.error.code, 'invalidAnswer'); assert.deepEqual(bad.decision, offer.decision);
    await game.cancel(game.decision.id);
    assert.equal(game.observation.turn, turn); assert.equal(game.observation.here.items.length, 2);
    offer = await game.pickup();
    const result = await game.answer(offer.decision.id, { kind: 'choice', choose: offer.decision.options.map(o => o.id) });
    assert.equal(result.outcome.turnsElapsed, 1); assert.equal(game.observation.here.items.length, 0);
  });
}
