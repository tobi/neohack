import {test} from 'node:test';
import assert from 'node:assert/strict';
export const defaults = {enabled:true, itemTypes:['gold'], arrows:true, leaveCorpses:true, leaveKnownCursed:true};
const hero = {name:'Pickup', role:'ranger', race:'human', gender:'female', align:'neutral', seed:42};
const compass = {'-1,-1':'northwest','0,-1':'north','1,-1':'northeast','-1,0':'west','1,0':'east','-1,1':'southwest','0,1':'south','1,1':'southeast'};
async function cross(game) {
  const c = game.observation.neighborhood.cells.find(c => Math.abs(c.dx) + Math.abs(c.dy) === 1 && !c.occupant && !c.hazards?.length && c.movement.intent === 'step' && c.actions.some(a=>a.key === 'move' && a.availability === 'attemptable'));
  assert.ok(c, 'safe adjacent square in this seeded world');
  await game.move(compass[`${c.dx},${c.dy}`]);
  assert.equal(game.decision, null);
  await game.move(compass[`${-c.dx},${-c.dy}`]);
  assert.equal(game.decision, null);
}
export function pickupSettingsContracts(name, fixture) {
  test(`${name}: automatic pickup settings are validated, zero-turn, journaled and receipt-idempotent`, async t => {
    const b = await fixture(t);
    let game = await b.api.create({...hero, automaticPickup:defaults});
    assert.deepEqual(game.observation.automaticPickup, defaults);
    const before = game.state;
    const configured = {...defaults, enabled:false, itemTypes:['food','potions']};
    const r = await game.configurePickup(configured);
    assert.equal(r.observation.turn, before.observation.turn);
    assert.equal(r.revision, before.revision + 1);
    assert.deepEqual(r.observation.automaticPickup, configured);
    assert.deepEqual(await b.api.request('game.configurePickup', {sessionId:game.id, requestId:r.requestId, expectedRevision:before.revision, automaticPickup:configured}), r);
    game = await b.restart(game);
    assert.deepEqual(game.observation.automaticPickup, configured);
    await assert.rejects(game.configurePickup({...defaults,itemTypes:['invalid']}));
    await assert.rejects(game.configurePickup({...defaults,itemTypes:['gold','gold']}));
    assert.deepEqual(game.observation.automaticPickup, configured);
    await game.pray();
    const decision = game.decision;
    await assert.rejects(game.configurePickup(defaults), e=>e.response.error.code === 'pendingDecision');
    assert.deepEqual(game.decision, decision);
    await game.cancel(decision.id);
    await game.eat();
    const itemChoice = game.decision;
    assert.equal(itemChoice.kind,'item');
    await assert.rejects(game.configurePickup(defaults), e=>e.response.error.code === 'pendingDecision');
    assert.deepEqual(game.decision,itemChoice,'settings do not replace a free item selection');
    await game.cancel(itemChoice.id);
  });
  for (const [description, settings, category, collected] of [
    ['default includes arrows', defaults, 'arrow', true],
    ['default leaves other weapons', defaults, 'bow', false],
    ['empty types retains arrow inclusion', {...defaults,itemTypes:[]}, 'arrow', true],
    ['empty types without inclusion picks nothing', {...defaults,itemTypes:[],arrows:false}, 'arrow', false],
    ['off preserves filters without collecting', {...defaults,enabled:false}, 'arrow', false],
    ['weapon category applies with arrow exception off', {...defaults,itemTypes:['weapons'],arrows:false}, 'arrow', true],
    ['food category collects uncursed food', {...defaults,itemTypes:['food']}, 'food', true],
  ]) test(`${name}: ${description} during actual movement`, async t => {
    const b = await fixture(t), game = await b.api.create({...hero, automaticPickup:settings});
    const item = game.observation.inventory.find(i => category === 'food' ? i.category === 'food' : new RegExp(category).test(i.label));
    assert.ok(item);
    await game.drop({id:item.id});
    assert.equal(game.decision, null);
    assert.equal(game.observation.here.items.length, 1);
    const floorId = game.observation.here.items[0].id;
    await cross(game);
    assert.equal(game.observation.here.items.some(i=>i.id === floorId), !collected);
    assert.equal(game.observation.inventory.some(i=>i.id === item.id), collected);
  });
  test(`${name}: configured gold pickup works on ground without collecting other items`, async t => {
    const b = await fixture(t), game = await b.api.create({...hero,role:'tourist',automaticPickup:defaults});
    const gold = game.observation.inventory.find(i=>i.category === 'coin');
    assert.ok(gold);
    await game.drop({id:gold.id});
    await cross(game);
    assert.ok(game.observation.inventory.some(i=>i.id === gold.id));
  });
}
