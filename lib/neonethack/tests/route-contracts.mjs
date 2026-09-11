import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Navigator,Hero,NavigationError} from '../dist/typescript/client.js';
const identity = {name:'Route',seed:42,role:'valkyrie',race:'dwarf',gender:'female',align:'lawful'};
export function routeContracts(test, label, fixture) {
  test(`${label}: noRoute names occupied, unknown and disconnected destinations`,async t=>{
    const {api}=await fixture(t),game=await api.create(identity);
    const pet=game.observation.world.find(cell=>cell.occupant?.kind==='ally');
    assert.ok(pet,'starting companion is perceived');
    const occupied=await game.route({x:pet.x,y:pet.y});
    assert.equal(occupied.distance,null);assert.equal(occupied.why,'targetOccupied');
    const blocked=await game.go({to:{x:pet.x,y:pet.y}});
    assert.equal(blocked.reason,'noRoute');assert.equal(blocked.why,'targetOccupied');
    assert.match(blocked.hint,/ordinary movement/);assert.doesNotMatch(blocked.hint,/Attack the occupant/);
    assert.equal(blocked.actionsTaken,0);assert.equal(blocked.recover,undefined);
    const fog=await game.go({to:{x:1,y:0}});
    assert.equal(fog.reason,'noRoute');
    assert.ok(['targetUnknown','disconnected'].includes(fog.why));
    assert.ok(fog.hint);
    const door=game.observation.world.find(cell=>cell.terrain?.type==='closedDoor');
    if(door){
      const shut=await game.go({to:{x:door.x,y:door.y}});
      assert.equal(shut.reason,'noRoute');assert.equal(shut.why,'closedDoor');
      assert.match(shut.hint,/Open the door/);
    }
  });
  test(`${label}: explicitly bounded multi-frontier exploration matches separate deliberate legs`,async t=>{
    const {api}=await fixture(t);
    const identity={name:'Frontiers',role:'valkyrie',seed:42};
    const single=await api.create(identity),batch=await api.create(identity);
    for(const game of [single,batch]) {
      await game.go({to:{x:59,y:6}});await game.open('west');
      for(let i=0;i<16;i++)await game.explore({maxActions:20});
      await game.explore({maxActions:20});
      assert.equal(game.observation.turn,33,'fixture reaches the second open door');
    }
    let actions=0,turns=0,firstActions,reason='arrived';
    for(let i=0;i<4;i++) {
      const leg=await single.explore({maxActions:40});
      firstActions??=leg.actionsTaken;actions+=leg.actionsTaken;turns+=leg.turnsElapsed;
      reason=leg.reason;if(reason!=='arrived')break;
    }
    const result=await batch.explore({maxActions:40,maxFrontiers:4});
    assert.equal(result.reason,reason);assert.equal(result.actionsTaken,actions);
    assert.equal(result.turnsElapsed,turns);assert.ok(actions>firstActions);
    assert.deepEqual(batch.observation.you,single.observation.you);
    assert.equal(batch.observation.turn,single.observation.turn);
    await assert.rejects(batch.explore({maxFrontiers:0}),/maxFrontiers/);
    await batch.eat();
    assert.equal((await batch.explore({maxActions:40,maxFrontiers:4})).reason,'decision');
  });
  test(`${label}: navigation failures retain confirmed progress and never retry uncertain input`,async t=>{
    const {api,transport}=await fixture(t),game=await api.create({...identity,seed:1});
    let route;
    for(const cell of game.observation.world) {
      const candidate=await game.route({x:cell.x,y:cell.y});
      if(candidate.distance>=2){route=candidate;break;}
    }
    assert.ok(route,'fixture needs a multi-step route');
    const start=game.observation.turn,send=transport.send.bind(transport);let attempts=0;
    transport.send=async request=>{
      if(request.method==='game.move' && ++attempts===2)throw Error('test transport reply unavailable');
      return send(request);
    };
    await assert.rejects(game.go({to:route.to}),error=>{
      assert.ok(error instanceof NavigationError);
      assert.equal(error.result.reason,'error');assert.equal(error.result.actionsTaken,1);
      assert.equal(error.result.turnsElapsed,1);assert.equal(error.result.snapshot.observation.turn,start+1);
      assert.ok(game.pendingRequest,'uncertain exact input remains retained');return true;
    });
    assert.equal(attempts,2,'no implicit retry');
    transport.send=send;
    await game.retry();assert.equal(game.observation.turn,start+2);
  });
  test(`${label}: a failed durability reply still counts its witnessed navigation input`,async t=>{
    const {api,transport}=await fixture(t),game=await api.create({...identity,seed:1});
    let route;
    for(const cell of game.observation.world) {
      const candidate=await game.route({x:cell.x,y:cell.y});
      if(candidate.distance>=2){route=candidate;break;}
    }
    assert.ok(route);
    const start=game.observation.turn,send=transport.send.bind(transport);let moves=0;
    transport.send=async request=>{
      const response=await send(request);
      if(request.method==='game.move' && ++moves===2)return {...response,error:{code:'incompleteRequest',message:'test receipt temporarily unavailable'}};
      return response;
    };
    await assert.rejects(game.go({to:route.to}),error=>{
      assert.ok(error instanceof NavigationError);assert.equal(error.result.actionsTaken,2);
      assert.equal(error.result.turnsElapsed,2);assert.equal(error.result.snapshot.observation.turn,start+2);
      assert.ok(game.pendingRequest);return true;
    });
    transport.send=send;
    await game.retry();assert.equal(game.observation.turn,start+2,'exact recovery must not repeat the witnessed move');
  });
  test(label+': destination walking crosses the old eight-action limit and Hero exposes exploration',async t=>{
    const {api}=await fixture(t),game=await api.create({name:'Range',role:'valkyrie',seed:1}),hero=new Hero(game);
    await hero.explore({maxActions:8});await hero.explore({maxActions:8});
    const to={x:43,y:8},route=await game.route(to);
    assert.ok(route.distance>8,'fixture must expose a distant known destination');
    const result=await hero.go({to});assert.equal(result.reason,'arrived');
    assert.ok(result.actionsTaken>8);assert.deepEqual({x:game.observation.you.x,y:game.observation.you.y},to);
    const abort=new AbortController();abort.abort();
    assert.equal((await hero.descend({signal:abort.signal})).reason,'aborted');
  });
  test(`${label}: navigation reports each executed step and honors cancellation at its boundary`,async t=>{
    const {api}=await fixture(t),game=await api.create({...identity,seed:1});
    let route;
    for(const cell of game.observation.world){
      const candidate=await game.route({x:cell.x,y:cell.y});
      if(candidate.distance>=2){route=candidate;break;}
    }
    assert.ok(route,'fixture needs a multi-step public route');
    const controller=new AbortController(),frames=[];
    const result=await game.go({to:route.to,signal:controller.signal,onStep:frame=>{frames.push(frame);controller.abort();}});
    assert.equal(result.reason,'aborted');assert.equal(result.actionsTaken,1);assert.equal(frames.length,1);
    assert.deepEqual(frames[0],game.state);
  });

  test(`${label}: go force is adjacent ordinary movement and attack remains a distinct engine action`, async t => {
    const {api,transport}=await fixture(t), game=await api.create(identity), hero=new Hero(game);
    const origin=game.observation.you, turn=game.observation.turn;
    await assert.rejects(game.go({to:{x:origin.x>40?origin.x-2:origin.x+2,y:origin.y},force:true}),/adjacent square/i);
    await assert.rejects(game.go({to:{x:origin.x,y:origin.y},force:true}),/adjacent square/i);
    assert.equal(game.observation.turn,turn);
    const moves=[], send=transport.send.bind(transport);
    transport.send=async request=>{if(request.method.startsWith('game.'))moves.push(request.method);return send(request);};
    const adjacent=()=>game.observation.neighborhood.cells.find(c=>c.movement.relation==='adjacent' && c.movement.intent==='step' && !c.movement.knownRestriction && (!c.dx||!c.dy));
    const to=adjacent(); assert.ok(to);
    const moved=await hero.go({to:{x:to.x,y:to.y},force:true});
    assert.equal(moved.reason,'arrived'); assert.deepEqual(moves,['game.move']);
    const target=adjacent(); assert.ok(target);
    const before={...game.observation.you};
    await hero.attack({target:{x:target.x,y:target.y}});
    assert.deepEqual(moves,['game.move','game.attack']);
    assert.deepEqual(game.observation.you,before,'attacking empty floor is not walking there');
  });
  test(`${label}: routes are perceived, revision-bound and free across decisions and resume`, async t => {
    const b = await fixture(t), game = await b.api.create(identity);
    const original = game.state;
    const origin = game.observation.neighborhood.basis.origin;
    const navigator = new Navigator(game);
    assert.equal((await navigator.go({to:origin})).reason,'arrived');
    await assert.rejects(navigator.go({to:origin,maxActions:0}),/maxActions/);
    const aborted = new AbortController(); aborted.abort();
    assert.equal((await navigator.explore({signal:aborted.signal})).reason,'aborted');
    const journal = b.sessions ? `${b.sessions}/${game.id}/input.log.jsonl` : null;
    const bytes = journal ? await readFile(journal,'utf8') : null;
    const here = await game.route(origin);
    const nav = await game.navigation();
    assert.equal(nav.kind,'navigation');
    assert.ok(!nav.frontiers.some(c=>c.x===origin.x && c.y===origin.y));
    for (const frontier of nav.frontiers) {
      const path = await game.route({x:frontier.x,y:frontier.y});
      assert.equal(path.distance,frontier.distance);
      assert.ok(path.distance>0);
    }
    for (const stair of nav.waysDown) {
      assert.ok(game.observation.world.some(c=>c.x===stair.x && c.y===stair.y && c.terrain.type==='stairsDown'));
    }
    assert.equal(here.distance,0); assert.deepEqual(here.steps,[]);
    assert.equal(here.policy,'knownWalking');
    const cells = game.observation.neighborhood.cells;
    const step = cells.find(c => c.movement.relation==='adjacent' && c.movement.intent==='step' && c.walkable && !c.movement.knownRestriction && !c.movement.requiresSqueeze && !c.hazards?.length && (!c.dx || !c.dy));
    assert.ok(step, 'seed has a perceived cardinal walking step');
    const to = {x:step.x,y:step.y};
    const route = await game.route(to);
    assert.equal(route.distance,1); assert.deepEqual(route.steps.map(({x,y})=>({x,y})),[to]);
    assert.equal(route.steps[0].direction,step.dx>0?'east':step.dx<0?'west':step.dy>0?'south':'north');
    assert.deepEqual(await game.route(to),route);
    assert.equal(game.state,original);
    assert.deepEqual((await game.observe()).observation,original.observation);
    if(journal) assert.equal(await readFile(journal,'utf8'),bytes, 'queries append no engine inputs');
    const unknown = cells.find(c=>c.inBounds && c.terrain.type==='unknown');
    if(unknown) assert.equal((await game.route({x:unknown.x,y:unknown.y})).distance,null);
    const stale = await b.api.request('session.route',{sessionId:game.id,expectedRevision:game.state.revision+1,to});
    assert.equal(stale.error.code,'staleRevision');
    for(const bad of [{x:0,y:1},{x:80,y:1},{x:1,y:21},{x:1,y:1,extra:true}]) {
      const r=await b.api.request('session.route',{sessionId:game.id,expectedRevision:game.state.revision,to:bad});
      assert.equal(r.error.code,'invalidParams');
    }
    await game.eat();
    assert.equal(game.decision.kind,'item');
    const pending = game.decision;
    const stopped = await navigator.explore();
    assert.equal(stopped.reason,'decision'); assert.equal(stopped.actionsTaken,0);
    const q = await game.route(origin);
    const pendingNav = await game.navigation();
    assert.deepEqual(q.inputGate,{state:'decision',decisionId:pending.id});
    assert.equal(game.decision,pending);
    await game.close();
    const resumed=await b.api.resume(game.id);
    assert.deepEqual(await resumed.route(origin),q);
    assert.deepEqual(await resumed.navigation(),pendingNav,'replay rebuilds witnessed positions and frontiers');
    await resumed.cancel(resumed.decision.id);
    const travelled = await resumed.go({to,maxActions:1});
    assert.equal(travelled.reason,'arrived'); assert.equal(travelled.actionsTaken,1);
    assert.deepEqual(resumed.observation.neighborhood.basis.origin,to);
    assert.ok(!(await resumed.navigation()).frontiers.some(c=>c.x===to.x && c.y===to.y));
  });
  test(`${label}: opt-in navigation obeys its action budget and aborts between real inputs`, async t => {
    const {api,transport} = await fixture(t);
    const game = await api.create(identity), navigator = new Navigator(game);
    const frontier = (await game.navigation()).frontiers.find(p=>p.distance>1);
    assert.ok(frontier,'seed exposes a multi-step frontier');
    const before=game.observation.turn;
    const leg = await navigator.explore({maxActions:1});
    assert.equal(leg.reason,'stepLimit'); assert.equal(leg.actionsTaken,1);
    assert.equal(game.observation.turn,before+1);
    const controller=new AbortController(), send=transport.send.bind(transport);
    let inputs=0;
    transport.send=async request=>{
      const response=await send(request);
      if(request.method==='game.move') {inputs++;controller.abort();}
      return response;
    };
    const interrupted = await navigator.go({to:{x:frontier.x,y:frontier.y},signal:controller.signal});
    assert.equal(interrupted.reason,'aborted'); assert.equal(inputs,1); assert.equal(interrupted.actionsTaken,1);
  });
  test(`${label}: navigation reaches a second level through public operations and remembers visits across return and replay`, {timeout:30000}, async t => {
    const {api}=await fixture(t);
    let game=await api.create({...identity,name:'Navigation',seed:7});
    const navigator=new Navigator(game), firstLevel=game.observation.location.id;
    const start=(await game.navigation()).basis.origin;
    for(let legs=0; legs<60 && game.observation.location.id===firstLevel; legs++) {
      const nav=await game.navigation();
      const result=await (nav.waysDown.some(s=>s.distance!==null) ? navigator.descend() : navigator.explore());
      assert.ok(!game.decision && !game.state.ended,JSON.stringify(result));
      assert.notEqual(result.reason,'noRoute');
    }
    assert.notEqual(game.observation.location.id,firstLevel,'seeded public-only navigation reaches depth 2');
    await game.climb('up');
    assert.equal(game.observation.location.id,firstLevel);
    const returned=await game.navigation();
    assert.ok(!returned.frontiers.some(c=>c.x===start.x && c.y===start.y),'returning to a level retains its witnessed visits');
    await game.close(); game=await api.resume(game.id);
    assert.deepEqual(await game.navigation(),returned);
  });
}
