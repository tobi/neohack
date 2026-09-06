import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, identity } from './native-fixture.mjs';
import { Hero, direction, entities, Entity } from '../dist/typescript/client.js';

test('hero uses real observations, excludes pets from enemies, expires handles and forwards engine item queries', async t => {
  const { api } = await fixture(t);
  const game = await api.create(identity), hero = new Hero(game);
  const pet = hero.senseClosest(entities.Ally);
  assert.ok(pet instanceof Entity, 'fixture must expose a visible pet');
  assert.equal(pet.attitude, 'tame');
  assert.equal(hero.sense(entities.Enemy).length, 0);
  assert.deepEqual(pet.offset, [pet.position[0] - game.observation.you.x, pet.position[1] - game.observation.you.y]);
  assert.ok(Object.isFrozen(pet));
  assert.throws(() => hero.attack(pet), /hostile/);
  assert.equal(hero.isHungry(), false);
  assert.ok(hero.inventory.items.length);
  const item = hero.inventory.items[0];
  assert.equal(hero.inventory.byId(item.info.id).info.id, item.info.id);
  assert.equal(hero.inventory.byId('not-a-real-id'), undefined);
  await assert.rejects(hero.inventory.find('utterly nonexistent bread').eat(), e => e.response.error.code === 'noMatch' && e.response.outcome.turnsElapsed === 0);
  await hero.wait();
  assert.throws(() => hero.go(pet), /Stale/);
  assert.throws(() => item.eat(), /Stale/);
  const ration = hero.inventory.items.find(i => i.info.label.includes('food ration'));
  assert.ok(ration, 'actual ration required');
  const frame = await hero.inventory.find('food ration').eat();
  assert.notEqual(frame.outcome.status, 'blocked');
  assert.ok(frame.observation.turn > 1);
  if (!hero.decision) await hero.go(direction.northWest);
});

test('hero target handles cannot cross real sessions or bypass queued revision checks', async t => {
  const { api } = await fixture(t);
  const hero = new Hero(await api.create(identity));
  const other = new Hero(await api.create({ ...identity, name: 'Other' }));
  assert.throws(() => other.go(hero.senseClosest(entities.Ally)), /foreign/);
  const pet = hero.senseClosest(entities.Ally);
  const wait = hero.wait();
  const queued = hero.go(pet);
  await wait;
  await assert.rejects(queued, /revision/i);
});

test('initialize once, ordered observations, awaited turn callbacks and every intermediate real frame', async t => {
  const {api} = await fixture(t); const game = await api.create(identity), hero = new Hero(game);
  const order=[], revisions=[], frames=[]; let turns=0, entered=0, items=0, seen=0, removed=0;
  const listener=()=>removed++;
  const result=await hero.initialize(h=>{
    h.addEventListener('enterLevel',()=>{entered++;order.push('level');},{once:true});
    h.addEventListener('entitySeen',({detail})=>{seen++;assert.ok(detail.entity instanceof Entity);assert.equal(detail.entity.attitude,'tame');});
    h.addEventListener('itemSeen',({detail})=>{if(detail.sighting.source==='inventory')items++;});
    h.addEventListener('stateChange',({detail})=>{
      frames.push(detail.snapshot); revisions.push(detail.snapshot.revision); order.push('state');
      assert.ok(Object.isFrozen(detail.snapshot));
      assert.throws(()=>h.wait(),/turn listener/);
    });
    h.addEventListener('mapChange',listener);h.removeEventListener('mapChange',listener);
    h.addEventListener('turn',async()=>{
      order.push('turn');turns++;
      if(turns===1){await h.wait();await h.wait();}else h.stop();
    });
    assert.throws(()=>h.addEventListener('turn',()=>{}),/one turn listener/);
  });
  assert.equal(result.reason,'stopped');assert.equal(turns,2);assert.equal(entered,1);assert.ok(items>0);assert.ok(seen>0);assert.equal(removed,0);
  assert.deepEqual(revisions,[0,1,2]);assert.ok(order.indexOf('level')<order.indexOf('turn'));assert.equal(frames[1].observation.turn,2);
  assert.ok(hero.inventory.items.some(i=>i.canEat()===true));assert.ok(hero.inventory.items.filter(i=>i.info.usage?.includes('worn')).every(i=>i.canEquip()===false));
  await assert.rejects(hero.initialize(()=>{}),/only be called once/);
  await game.wait(); // ownership released; an explicit host can continue the session.
});

test('read-only turns become idle without implicit input or duplicate events',async t=>{
  const {api}=await fixture(t); const hero=new Hero(await api.create(identity));let states=0, turns=0;
  const result=await hero.initialize(h=>{
    h.addEventListener('stateChange',()=>states++);
    h.addEventListener('turn',async()=>{turns++;await h.game.observe();await h.game.observe();});
  });
  assert.equal(result.reason,'idle');assert.equal(turns,1);assert.equal(states,1);assert.equal(hero.state.observation.turn,1);
});

test('missing awaits settle input and fail the lifecycle without orphaning actions',async t=>{
  const {api}=await fixture(t);const hero=new Hero(await api.create(identity));
  await assert.rejects(hero.initialize(h=>{h.addEventListener('turn',()=>{void h.wait();});}),/Await every game operation/);
  assert.equal(hero.state.observation.turn,2);assert.equal(hero.game.pendingRequest,null);
});

test('lifecycle preserves uncertain requests and emits error without retrying',async t=>{
  const {api,transport}=await fixture(t);const game=await api.create(identity), hero=new Hero(game);
  const send=transport.send.bind(transport);let calls=0,errors=0;
  transport.send=async request=>{const response=await send(request);if(request.method==='game.wait'){calls++;throw Error('lost receipt');}return response;};
  await assert.rejects(hero.initialize(h=>{
    h.addEventListener('error',()=>errors++);
    h.addEventListener('turn',async()=>{await h.wait();});
  }),/may have executed/);
  assert.equal(calls,1);assert.equal(errors,1);assert.ok(game.pendingRequest);
  transport.send=send;const recovered=await game.retry();assert.equal(recovered.observation.turn,2);
});

test('real pickup emits a new inventory item that can be equipped, then eating changes inventory',async t=>{
  const {api}=await fixture(t);const game=await api.create(identity);
  const shield=game.observation.inventory.find(i=>i.category==='armor' && i.usage?.includes('worn'));assert.ok(shield);
  await game.remove({id:shield.id});await game.drop({id:shield.id});
  const hero=new Hero(game),sightings=[];let steps=0,inventoryChanges=0,gearId;
  await hero.initialize(h=>{
    h.addEventListener('itemSeen',({detail:{sighting}})=>{
      sightings.push(sighting.source);
      if(sighting.source==='inventory' && sighting.item.actions?.includes('equip'))gearId=sighting.item.id;
    });
    h.addEventListener('inventoryChange',()=>inventoryChanges++);
    h.addEventListener('turn',async()=>{
      assert.equal(h.decision,null);
      if(steps===0){const floor=h.itemsHere?.find(i=>i.info.category==='armor');assert.ok(floor);await floor.pickup();}
      else if(steps===1){assert.ok(gearId);const gear=h.inventory.byId(gearId);assert.equal(gear.canEquip(),true);await gear.equip();}
      else if(steps===2){assert.ok(h.inventory.byId(gearId).info.usage.includes('worn'));const food=h.inventory.items.find(i=>i.canEat());assert.ok(food);await food.eat();}
      else h.stop();
      steps++;
    });
  });
  assert.ok(sightings.includes('here'));assert.ok(sightings.includes('inventory'));assert.ok(inventoryChanges>=3);assert.equal(steps,4);
});
