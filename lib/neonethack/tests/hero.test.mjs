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
    h.addEventListener('snapshotChange',({detail})=>{
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
    h.addEventListener('snapshotChange',()=>states++);
    h.addEventListener('turn',async()=>{turns++;await h.game.observe();await h.game.observe();});
  });
  assert.equal(result.reason,'idle');assert.equal(turns,1);assert.equal(states,1);assert.equal(hero.snapshot.observation.turn,1);
});

test('missing awaits settle input and fail the lifecycle without orphaning actions',async t=>{
  const {api}=await fixture(t);const hero=new Hero(await api.create(identity));
  await assert.rejects(hero.initialize(h=>{h.addEventListener('turn',()=>{void h.wait();});}),/Await every game operation/);
  assert.equal(hero.snapshot.observation.turn,2);assert.equal(hero.game.pendingRequest,null);
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

test('named bot captures construction autoloot and applies journaled rules before initialization', async t => {
  const { defineBot, runBot } = await import('../dist/typescript/client.js');
  const { api } = await fixture(t);
  const game = await api.create(identity);
  const before = game.state;
  for (const name of [undefined, '', '   ', 'x\ny', 'a'.repeat(61)]) {
    assert.throws(() => defineBot({ name, initialize() {} }), /name/);
    await assert.rejects(runBot(game, { name, initialize() {} }), /name/);
  }
  assert.equal(game.state.revision, before.revision, 'invalid definitions submit no input');
  const rules = { enabled: true, itemTypes: ['gold'], arrows: false, leaveCorpses: true, leaveKnownCursed: true };
  let initialized = false;
  const bot = defineBot({ name: '  Gold imp  ', autoloot: rules, initialize({ hero }) {
    initialized = true;
    assert.deepEqual(hero.snapshot.observation.automaticPickup, { ...rules, itemTypes: ['gold'] });
    assert.equal(hero.snapshot.observation.turn, before.observation.turn);
    assert.ok(hero.snapshot.revision > before.revision, 'configuration is journaled');
    hero.stop();
  } });
  rules.itemTypes.push('food');
  assert.equal(bot.name, 'Gold imp');
  assert.ok(Object.isFrozen(bot.autoloot.itemTypes));
  await runBot(game, bot);
  assert.equal(initialized, true);
});

test('script state is independent, vetoable, and null silences every later callback until forced resume',async t=>{
  const {api}=await fixture(t);const game=await api.create(identity);const notes=[],states=[];
  const hero=new Hero(game,{name:'Quiet imp',host:{journal:e=>notes.push(e),state:s=>states.push(s)}});
  const calls=[];let resumed=false;
  const result=await hero.initialize(h=>{
    assert.equal(h.state,'run');
    h.controls.button({id:'pause',label:'Pause',onClick:()=>{calls.push('control');return null;}});
    h.addEventListener('stateChange',({detail})=>{calls.push(`${detail.from}->${detail.to}`);if(detail.to==='forbidden')detail.deny();});
    h.addEventListener('snapshotChange',()=>{calls.push('snapshot');if(!resumed)return 'explore';});
    h.addEventListener('turn',async()=>{
      if(resumed){h.stop();return;}
      assert.equal(h.state,'explore');assert.equal(await h.setState('forbidden'),false);assert.equal(h.state,'explore');
      h.journal.log('Looking around', {depth:h.location.depthLabel});
      await h.wait();return null;
    });
    h.addEventListener('stop',()=>{calls.push('stop');});
    h.addEventListener('error',()=>{calls.push('error');});
  });
  assert.equal(result.reason,'yielded');assert.equal(hero.state,null);assert.equal(game.observation.turn,2);
  assert.equal(calls.filter(v=>v==='snapshot').length,1,'queued receipt is silent after null');
  assert.ok(!calls.includes('stop'));assert.ok(!calls.includes('error'));
  assert.deepEqual(states,['run','explore',null]);assert.equal(notes[0].source,'script');assert.equal(notes[0].author,'Quiet imp');
  const silent=[...calls];hero.journal.log('Must not run');assert.equal(notes.length,1);
  assert.equal(await hero.controls.invoke('pause'),false);assert.equal(await hero.setState('run'),false);
  assert.throws(()=>hero.wait(),/suspended/);assert.throws(()=>hero.inventory.items[0].drop(),/suspended/);
  await game.wait();assert.deepEqual(calls,silent,'player input must not deliver script events');
  resumed=true;assert.equal(await hero.setState('run',{force:true}),true);assert.deepEqual(calls,silent,'resume bypasses sleeping script callbacks');
  assert.equal((await hero.resume()).reason,'stopped');assert.equal(calls.filter(v=>v==='snapshot').length,2);
});

test('null during notification suppresses later listeners of that same event',async t=>{
  const {api}=await fixture(t);const hero=new Hero(await api.create(identity));let later=0;
  const result=await hero.initialize(h=>{
    h.addEventListener('snapshotChange',()=>null);
    for(const event of ['snapshotChange','mapChange','enterLevel','turn','stop','error'])h.addEventListener(event,()=>{later++;});
  });
  assert.equal(result.reason,'yielded');assert.equal(later,0);assert.equal(hero.snapshot.observation.turn,1);
});

test('controls queue behind an awaited real action and can return structured state or null',async t=>{
  const {api}=await fixture(t);const hero=new Hero(await api.create(identity));const events=[];let invoke;
  const result=await hero.initialize(h=>{
    h.controls.checkbox({id:'bold',label:'Be bold',checked:false,onChange:checked=>{events.push(['control',h.snapshot.observation.turn,checked]);return {state:{mode:'bold'}};}});
    h.addEventListener('stateChange',({detail})=>{events.push(['state',detail.to]);});
    h.addEventListener('turn',async()=>{
      if(h.state==='run'){
        const input=h.wait();invoke=h.controls.invoke('bold',true);await input;events.push(['action',h.snapshot.observation.turn]);
      }else {assert.deepEqual(h.state,{mode:'bold'});assert.ok(Object.isFrozen(h.state));return null;}
    });
  });
  assert.equal(result.reason,'yielded');assert.equal(await invoke,true);assert.deepEqual(events.slice(0,2),[['action',2],['control',2,true]]);
  assert.equal(hero.controls.descriptors[0].checked,true);
});

test('initialization can yield without delivering any script event, forced state bypasses veto',async t=>{
  const {api}=await fixture(t);const hero=new Hero(await api.create(identity));let called=0;
  assert.equal((await hero.initialize(h=>{
    h.addEventListener('stateChange',({detail})=>{called++;detail.deny();});
    h.addEventListener('turn',()=>{called++;});
    return h.setState(null,{force:true}).then(()=>undefined);
  })).reason,'yielded');assert.equal(called,0);
});

test('a player override supersedes the result of an older awaited callback',async t=>{
  const {api}=await fixture(t);const hero=new Hero(await api.create(identity));let begin,release;
  const begun=new Promise(resolve=>{begin=resolve;});const gate=new Promise(resolve=>{release=resolve;});
  const running=hero.initialize(h=>{h.addEventListener('turn',async()=>{begin();await gate;return 'old strategy';});});
  await begun;await hero.setState('player choice',{force:true});release();
  await running;assert.equal(hero.state,'player choice');
});

test('real beforeLoot hook can override suggested ground loot then reports confirmed acquisition',async t=>{
  const {pickupEngine}=await import('./pickup-engine-fixture.mjs');
  const {defaults}=await import('./pickup-settings-contracts.mjs');
  const options=await pickupEngine(t);const {api}=await fixture(t,options);
  const game=await api.create({...identity,race:'human',automaticPickup:{...defaults,review:true}});
  const hero=new Hero(game),looted=[];let reviews=0,turns=0;
  const result=await hero.initialize(h=>{
    h.addEventListener('itemLooted',({detail})=>{looted.push(detail.loot);});
    h.addEventListener('beforeLoot',async({detail})=>{
      reviews++;assert.equal(detail.source,'pickup');assert.ok(detail.decision.pickupReview);
      const food=detail.decision.options.find(o=>o.label.includes('test-food'));
      if(food){assert.equal(food.suggested,false);await detail.select([food.id]);}
      else await detail.cancel();
    });
    h.addEventListener('turn',async()=>{if(turns++===0)await h.go(direction.east);else return null;});
  });
  assert.equal(result.reason,'yielded');assert.equal(reviews,2);
  const food=looted.find(e=>e.item.label.includes('test-food'));assert.ok(food);assert.equal(food.quantity,1);assert.equal(food.source,'floor');
});

test('forcing the current state still supersedes an in-flight script return',async t=>{
  const {api}=await fixture(t);const hero=new Hero(await api.create(identity));let begin,release;
  const begun=new Promise(resolve=>{begin=resolve;});const gate=new Promise(resolve=>{release=resolve;});
  const running=hero.initialize(h=>{h.addEventListener('turn',async()=>{begin();await gate;return 'outdated';});});
  await begun;await hero.setState('run',{force:true});release();await running;
  assert.equal(hero.state,'run');
});

test('top-level bot handlers expose plain payloads, preserve ordering and unsubscribe', async t => {
  const {defineBot, runBot} = await import('../dist/typescript/client.js');
  const {api} = await fixture(t);
  const game = await api.create(identity);
  const bot = defineBot({name:'Flat events'});
  const order=[];let turns=0, removed=0;
  const off=bot.on('message',()=>removed++);off();
  bot.on('start',({hero})=>{
    order.push('start');
    const remove=hero.on('mapChange',()=>removed++);remove();
    hero.on('enterLevel',({to})=>{assert.equal(to.id,game.observation.location.id);order.push('hero level');},{once:true});
  });
  bot.on('enterLevel',({hero,to,log})=>{
    assert.equal(hero.snapshot.observation.location.id,to.id);
    order.push('bot level');log('Arrived',to.depthLabel);
  });
  bot.on('turn',async({hero,snapshot})=>{
    assert.equal(snapshot.revision,hero.snapshot.revision);turns++;
    if(turns===1) await hero.wait();else hero.stop();
  });
  assert.throws(()=>bot.on('turn',()=>{}),/one turn listener/);
  const result=await runBot(game,bot);
  assert.equal(result.reason,'stopped');assert.equal(turns,2);assert.equal(removed,0);
  assert.deepEqual(order,['start','bot level','hero level']);
});

test('top-level start can yield before events or engine input', async t => {
  const {defineBot, runBot} = await import('../dist/typescript/client.js');
  const {api} = await fixture(t);const game=await api.create(identity);
  const revision=game.state.revision;
  const bot=defineBot({name:'Yield at start'});
  bot.on('start',()=>null);
  bot.on('turn',()=>assert.fail('yield must suppress turn callbacks'));
  assert.equal((await runBot(game,bot)).reason,'yielded');
  assert.equal(game.state.revision,revision);
});

test('player state overrides also supersede an awaited top-level start handler', async t => {
  const {defineBot,runBot}=await import('../dist/typescript/client.js');
  const {api}=await fixture(t);const game=await api.create(identity);
  let begin,release,hero;
  const begun=new Promise(resolve=>{begin=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  const bot=defineBot({name:'Async setup'});
  bot.on('start',async context=>{hero=context.hero;begin();await gate;return 'old setup';});
  const running=runBot(game,bot);
  await begun;await hero.setState('player choice',{force:true});release();
  await running;assert.equal(hero.state,'player choice');
});
