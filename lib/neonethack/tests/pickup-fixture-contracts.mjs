import assert from 'node:assert/strict';
import {defaults} from './pickup-settings-contracts.mjs';
const hero = {name:'Policy',role:'valkyrie',race:'human',gender:'female',align:'lawful',seed:42};
const named = (items, name) => items.find(i=>i.label.includes(`named ${name}`));
export async function pickupFixtureContracts(t, fixture) {
  await t.test('creation configuration takes effect before initial ground pickup', async t => {
    for (const enabled of [true,false]) {
      const b = await fixture(t), game = await b.api.create({...hero,automaticPickup:{...defaults,enabled}});
      assert.equal(!!named(game.observation.inventory,'initial-arrow'),enabled);
      assert.equal(!!named(game.observation.here.items,'initial-arrow'),!enabled);
      assert.equal(game.observation.inventory.some(i=>i.category === 'coin'),enabled);
      await game.close();
    }
  });
  await t.test('automatic pickup preserves burden warnings for an explicit answer', async t => {
    const b = await fixture(t), game = await b.api.create({...hero,automaticPickup:{...defaults,itemTypes:['weapons']}});
    await game.move('east'); await game.move('east');
    assert.equal(game.decision?.kind,'confirmation');
    assert.match(game.decision.about,/trouble|lifting|continue/i);
    const revision = game.state.revision;
    await game.observe();
    assert.equal(game.state.revision,revision);
    assert.ok(game.decision, 'reading does not answer the warning');
    await game.answer(game.decision.id,{kind:'confirmation',confirm:false});
    assert.equal(named(game.observation.inventory,'heavy-swords'),undefined);
  });
  await t.test('exclusions win over categories, arrow inclusion, thrown and stolen recovery without revealing unknown curses', async t => {
    const b = await fixture(t), game = await b.api.create({...hero,automaticPickup:{...defaults,itemTypes:['gold','food']}});
    await game.move('east');
    assert.equal(game.decision, null);
    const inv = game.observation.inventory, floor = game.observation.here.items;
    for (const name of ['ordinary-arrow','hidden-curse','test-food']) assert.ok(named(inv,name),`${name} must be collected`);
    for (const name of ['known-curse','thrown-curse','stolen-curse','thrown-dagger','stolen-dagger','test-corpse','test-potion']) assert.ok(named(floor,name),`${name} must be left`);
    assert.doesNotMatch(named(inv,'hidden-curse').label, /cursed/, 'hidden curse is not disclosed or used');
    assert.ok(inv.some(i=>i.category === 'coin'), 'gold is collected');
    await game.configurePickup({...defaults,itemTypes:['weapons','food'],leaveKnownCursed:false,leaveCorpses:false});
    await game.move('west'); await game.move('east');
    for (const name of ['known-curse','thrown-curse','stolen-curse','thrown-dagger','stolen-dagger','test-corpse']) assert.ok(named(game.observation.inventory,name),`${name} is collected after explicitly relaxing rules`);
    assert.ok(named(game.observation.here.items,'test-potion'));
  });
  await t.test('all types retains exclusions and empty categories never mean all', async t => {
    const b = await fixture(t), game = await b.api.create({...hero,automaticPickup:{...defaults,itemTypes:[],arrows:false}});
    await game.move('east');
    assert.equal(game.observation.here.items.length, 11);
    const types = ['gold','food','potions','scrolls','weapons','armor','rings','amulets','tools','spellbooks','wands','gems','rocks','balls','chains'];
    await game.configurePickup({...defaults,itemTypes:types});
    await game.move('west'); await game.move('east');
    assert.ok(named(game.observation.inventory,'test-potion'));
    for (const name of ['known-curse','thrown-curse','stolen-curse','test-corpse']) assert.ok(named(game.observation.here.items,name));
  });
  await t.test('literal loot and ignore patterns use only perceived names and survive restart', async t => {
    const b = await fixture(t), settings={...defaults,itemTypes:[],arrows:false,lootPatterns:['-DAGGER','TEST-FOOD'],ignorePatterns:['STOLEN']};
    let game = await b.api.create({...hero,automaticPickup:settings});
    await game.move('east');
    assert.ok(named(game.observation.inventory,'thrown-dagger'));
    assert.ok(named(game.observation.inventory,'test-food'));
    assert.ok(named(game.observation.here.items,'stolen-dagger'));
    assert.ok(named(game.observation.here.items,'ordinary-arrow'));
    if(b.restart) { game=await b.restart(game); assert.deepEqual(game.observation.automaticPickup,settings); }
    await game.configurePickup({...defaults,itemTypes:[],arrows:false,leaveKnownCursed:false,lootPatterns:['arrow','healing'],ignorePatterns:['cursed']});
    await game.move('west'); await game.move('east');
    assert.ok(named(game.observation.inventory,'hidden-curse'), 'undisclosed curses do not match cursed');
    assert.ok(named(game.observation.here.items,'known-curse'));
    const potion=named(game.observation.here.items,'test-potion');
    assert.ok(potion, 'undiscovered healing identity must not match');
    assert.doesNotMatch(potion.label,/healing/i);
  });
  await t.test('review pauses automatic pickup, permits overrides and can cancel before dropping', async t => {
    const b = await fixture(t), game = await b.api.create({...hero,automaticPickup:{...defaults,review:true}});
    assert.equal(game.decision?.pickupReview,true);
    assert.equal(named(game.observation.inventory,'initial-arrow'),undefined);
    await game.cancel(game.decision.id);
    await game.move('east');
    const review=game.decision; assert.equal(review?.pickupReview,true);
    const food=review.options.find(o=>o.label.includes('test-food'));
    assert.equal(food.suggested,false);
    assert.ok(review.options.some(o=>o.suggested));
    assert.equal(named(game.observation.inventory,'test-food'),undefined);
    const taken=await game.answer(review.id,{kind:'choice',choose:[food.id]});
    assert.ok(named(game.observation.inventory,'test-food'));
    const witness=taken.events.find(e=>e.type==='itemLooted' && e.item.label.includes('test-food'));
    assert.equal(witness.source,'floor'); assert.equal(witness.quantity,1);
    assert.equal(witness.item.id,named(game.observation.inventory,'test-food').id);
    await game.move('west');
    assert.equal(game.decision?.pickupReview,true);
    await game.cancel(game.decision.id);
    const toDrop=game.observation.inventory.find(i=>i.label.includes('test-food'));
    const dropped=await game.drop({id:toDrop.id});
    assert.equal(dropped.decision,null);
    assert.equal(dropped.events.filter(e=>e.type==='itemLooted').length,0);
  });
  await t.test('one container plan puts only its original amount after a taken stack merges', async t => {
    const b = await fixture(t), game = await b.api.create(hero);
    const original = named(game.observation.inventory,'transfer-rations');
    assert.ok(original.quantity >= 5, 'fixture can merge with starting rations');
    await game.loot();
    if (!game.decision.containerPhase) {
      const box = game.decision.options.find(o=>o.label.includes('transfer-box'));
      await game.answer(game.decision.id,{kind:'choice',choose:[box.id]});
    }
    assert.equal(game.decision.containerPhase,'inspect');
    await game.answer(game.decision.id,{kind:'choice',choose:[game.decision.options[0].id]});
    const d = game.decision;
    const opened=game.state.events.find(e=>e.type==='containerOpened');
    assert.ok(opened?.container.label.includes('transfer-box'));
    assert.ok(opened.contents.some(i=>i.label.includes('transfer-rations')));
    const choices = d.options.filter(o=>o.label.includes('transfer-rations'));
    assert.deepEqual(choices.map(o=>o.transfer).sort(),['put','take']);
    const transferred=await game.answer(d.id,{kind:'choice',choose:choices.map(o=>o.id)});
    const acquisition=transferred.events.find(e=>e.type==='itemLooted');
    assert.equal(acquisition.source,'container');assert.equal(acquisition.quantity,3);
    assert.ok(acquisition.container.label.includes('transfer-box'));
    assert.equal(acquisition.item.quantity,original.quantity+3,'witness retains the stack size at the successful merge');
    assert.equal(game.decision,null);
    assert.equal(named(game.observation.inventory,'transfer-rations').quantity,3);
    await game.loot();
    const contents = game.decision.options.find(o=>o.transfer === 'take' && o.label.includes('transfer-rations'));
    assert.ok(contents.label.startsWith(`${original.quantity} `));
    await game.cancel(game.decision.id);
  });
}
