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
    const choices = d.options.filter(o=>o.label.includes('transfer-rations'));
    assert.deepEqual(choices.map(o=>o.transfer).sort(),['put','take']);
    await game.answer(d.id,{kind:'choice',choose:choices.map(o=>o.id)});
    assert.equal(game.decision,null);
    assert.equal(named(game.observation.inventory,'transfer-rations').quantity,3);
    await game.loot();
    const contents = game.decision.options.find(o=>o.transfer === 'take' && o.label.includes('transfer-rations'));
    assert.ok(contents.label.startsWith(`${original.quantity} `));
    await game.cancel(game.decision.id);
  });
}
