import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Navigator,NavigationError} from '../dist/typescript/navigator.js';
function fixture(change={}) {
  const observation={turn:1,you:{x:10,y:10},location:{id:'one'},vitals:{health:12,hunger:'not_hungry',condition:[]},world:[]};
  const game={state:{revision:0,observation,decision:null,ended:false},get observation(){return this.state.observation;},get decision(){return this.state.decision;},
    route:async()=>({distance:2,steps:[{direction:'east'}]}),
    move:async()=>{game.state={...game.state,revision:1,outcome:{status:'completed',turnsElapsed:1,positionChanged:true},observation:{...observation,turn:2,you:{x:11,y:10},...change}};return game.state;}};
  return game;
}
for(const [kind,change,before,after] of [
  ['healthLost',{vitals:{health:8,hunger:'not_hungry',condition:[]}},12,8],
  ['hungerChanged',{vitals:{health:12,hunger:'hungry',condition:[]}},'not_hungry','hungry'],
  ['conditionChanged',{vitals:{health:12,hunger:'not_hungry',condition:['blind']}},[],['blind']],
  ['levelChanged',{location:{id:'two'}},'one','two'],
])test(`navigator identifies ${kind} from the returned scene`,async()=>{
  const result=await new Navigator(fixture(change)).go({to:{x:12,y:10}});
  assert.equal(result.actionsTaken,1);assert.equal(result.turnsElapsed,1);
  assert.deepEqual(result.stop,{kind,before,after});
});
test('diagonal exploration probes only a C-offered move, skipping rejected corners',async()=>{
  const game=fixture(),queries=[],moves=[];
  game.navigation=async()=>({frontiers:[],waysDown:[],doors:[]});
  game.actions=async point=>{queries.push(point);return {cell:{movement:{relation:'adjacent',intent:'unknown',...(point.x===11&&point.y===9?{knownRestriction:'intactDoorDiagonal'}:{})},actions:point.x===11&&point.y!==10?[{method:'game.move',arguments:{direction:point.y===11?'southeast':'northeast'}}]:[]}};};
  game.move=async direction=>{moves.push(direction);return {...game.state,outcome:{status:'completed',turnsElapsed:1}};};
  const result=await new Navigator(game).explore();
  assert.deepEqual(moves,['southeast']);assert.equal(result.actionsTaken,1);
  assert.ok(queries.some(p=>p.x===11&&p.y===9),'ineligible diagonal examined before eligible one');
});

function walkingFixture() {
  const game=fixture(),queries=[],moves=[];
  game.route=async to=>{
    queries.push({...to});
    return {distance:to.x-game.observation.you.x,steps:[{direction:'east'}]};
  };
  game.move=async direction=>{
    moves.push(direction);
    const observation=game.observation;
    game.state={...game.state,revision:game.state.revision+1,requestId:`move-${moves.length}`,
      outcome:{status:'completed',turnsElapsed:1,positionChanged:true},
      observation:{...observation,turn:observation.turn+1,you:{x:observation.you.x+1,y:10}}};
    return game.state;
  };
  game.actions=async()=>({cell:{inBounds:true,movement:{relation:'adjacent',intent:'step'},actions:[{method:'game.move',arguments:{direction:'east'}}]}});
  return {game,queries,moves};
}

for(const distance of [0,1,3])test(`descend walks ${distance} squares then actually climbs before success`,async()=>{
  const {game,moves}=walkingFixture(),calls=[];
  game.navigation=async()=>({waysDown:[{x:10+distance,y:10,distance}],frontiers:[],doors:[]});
  game.climb=async(direction,options)=>{
    calls.push({direction,options});
    game.state={...game.state,revision:game.state.revision+1,requestId:'descent',
      outcome:{status:'completed',turnsElapsed:1,positionChanged:true},
      observation:{...game.observation,turn:game.observation.turn+1,location:{id:'two'}}};
    return game.state;
  };
  const result=await new Navigator(game).descend({maxActions:distance+1});
  assert.equal(result.reason,'arrived');
  assert.deepEqual(calls,[{direction:'down',options:{expectedRevision:distance}}]);
  assert.equal(moves.length,distance);assert.equal(result.actionsTaken,distance+1);
  assert.equal(result.turnsElapsed,distance+1);
  assert.deepEqual(result.stop,{kind:'levelChanged',before:'one',after:'two'});
  assert.equal(result.snapshot.observation.location.id,'two');
});

test('descend does not report success at stairs when the action budget excludes climbing',async()=>{
  const {game,moves}=walkingFixture();
  game.navigation=async()=>({waysDown:[{x:11,y:10,distance:1}],frontiers:[],doors:[]});
  game.climb=async()=>assert.fail('must not exceed the action budget');
  const result=await new Navigator(game).descend({maxActions:1});
  assert.equal(result.reason,'stepLimit');assert.equal(result.actionsTaken,1);
  assert.deepEqual(moves,['east']);assert.equal(result.snapshot.observation.location.id,'one');
});

for(const kind of ['unchanged','decision'])test(`descend preserves ${kind} climb instead of claiming arrival`,async()=>{
  const {game}=walkingFixture();
  game.navigation=async()=>({waysDown:[{x:10,y:10,distance:0}],frontiers:[],doors:[]});
  game.climb=async()=>{
    game.state={...game.state,decision:kind==='decision'?{id:'stairs-warning'}:null,
      outcome:{status:'completed',turnsElapsed:0,positionChanged:false}};
    return game.state;
  };
  const result=await new Navigator(game).descend();
  assert.equal(result.reason,kind==='decision'?'decision':'interrupted');
  assert.equal(result.actionsTaken,1);assert.equal(result.snapshot.observation.location.id,'one');
});

test('planning limit can stop before any query and invalid budgets do not lock the navigator',async()=>{
  const {game,moves,queries}=walkingFixture(),navigator=new Navigator(game);
  for(const maxPlanningMs of [-1,NaN,Infinity])
    await assert.rejects(navigator.go({to:{x:12,y:10},maxPlanningMs}),/maxPlanningMs/);
  const result=await navigator.go({to:{x:12,y:10},maxPlanningMs:0});
  assert.equal(result.reason,'planningLimit');assert.equal(result.queryCount,0);
  assert.equal(result.actionsTaken,0);assert.equal(result.turnsElapsed,0);
  assert.deepEqual(result.startPosition,result.endPosition);
  assert.deepEqual(result.selectedGoal,{x:12,y:10});
  assert.equal(result.lastOperationId,undefined);
  assert.deepEqual(moves,[]);assert.deepEqual(queries,[]);
  assert.equal((await navigator.go({direction:'east'})).reason,'arrived');
});

test('deadline after a route query returns zero progress without submitting input',async t=>{
  let now=0;t.mock.method(performance,'now',()=>now);
  const {game,moves}=walkingFixture(),route=game.route;
  game.route=async to=>{const result=await route(to);now=10;return result;};
  const result=await new Navigator(game).go({to:{x:12,y:10},maxPlanningMs:10});
  assert.equal(result.reason,'planningLimit');assert.equal(result.queryCount,1);
  assert.equal(result.planningElapsedMs,10);assert.equal(result.actionsTaken,0);
  assert.deepEqual(moves,[]);assert.equal(result.snapshot,game.state);
});

test('planning limit returns partial progress and the exact receipt without retry',async t=>{
  let now=0;t.mock.method(performance,'now',()=>now);
  const {game,moves}=walkingFixture(),route=game.route;
  game.route=async to=>{now+=6;return route(to);};
  const result=await new Navigator(game).go({to:{x:13,y:10},maxPlanningMs:10});
  assert.equal(result.reason,'planningLimit');assert.equal(result.actionsTaken,1);
  assert.equal(result.turnsElapsed,1);assert.equal(result.queryCount,2);
  assert.equal(result.planningElapsedMs,12);assert.equal(result.lastOperationId,'move-1');
  assert.deepEqual(result.startPosition,{x:10,y:10});assert.deepEqual(result.endPosition,{x:11,y:10});
  assert.deepEqual(result.selectedGoal,{x:13,y:10});assert.equal(result.snapshot,game.state);
  assert.deepEqual(moves,['east']);
});

test('accepted engine input is awaited and excluded from planning time',async t=>{
  let now=0;t.mock.method(performance,'now',()=>now);
  const {game,moves}=walkingFixture(),move=game.move;
  const started=Promise.withResolvers(),settlement=Promise.withResolvers();
  game.move=async direction=>{started.resolve();await settlement.promise;now+=5000;return move(direction);};
  let settled=false;
  const running=new Navigator(game).go({to:{x:11,y:10},maxPlanningMs:1}).then(result=>{settled=true;return result;});
  await started.promise;assert.equal(settled,false);
  settlement.resolve();
  const result=await running;
  assert.equal(result.reason,'arrived');assert.equal(result.actionsTaken,1);
  assert.equal(result.planningElapsedMs,0);assert.deepEqual(moves,['east']);
});

test('cancellation during a planning query stops before using its result',async()=>{
  for(const kind of ['go','step','explore']) {
    const {game,moves}=walkingFixture(),controller=new AbortController();
    const started=Promise.withResolvers(),settlement=Promise.withResolvers();
    const read=kind==='go'?'route':kind==='step'?'actions':'navigation';
    game.navigation=async()=>({frontiers:[],waysDown:[],doors:[]});
    const original=game[read];
    game[read]=async(...args)=>{started.resolve();await settlement.promise;return original(...args);};
    const navigator=new Navigator(game),options={signal:controller.signal};
    const running=kind==='explore'?navigator.explore(options):navigator.go({...options,...(kind==='step'?{direction:'east'}:{to:{x:12,y:10}})});
    await started.promise;controller.abort();settlement.resolve();
    const result=await running;
    assert.equal(result.reason,'aborted');assert.equal(result.queryCount,1);
    assert.equal(result.actionsTaken,0);assert.deepEqual(moves,[]);
  }
});

test('cancellation during accepted input waits for its receipt and preserves partial progress',async()=>{
  const {game,moves}=walkingFixture(),move=game.move,controller=new AbortController();
  const started=Promise.withResolvers(),settlement=Promise.withResolvers();
  game.move=async direction=>{started.resolve();await settlement.promise;return move(direction);};
  let settled=false;
  const running=new Navigator(game).go({to:{x:13,y:10},signal:controller.signal}).then(result=>{settled=true;return result;});
  await started.promise;controller.abort();assert.equal(settled,false);
  settlement.resolve();const result=await running;
  assert.equal(result.reason,'aborted');assert.equal(result.actionsTaken,1);
  assert.equal(result.turnsElapsed,1);assert.equal(result.lastOperationId,'move-1');
  assert.equal(result.snapshot,game.state);assert.deepEqual(moves,['east']);
});

test('engine decisions and interruptions survive cancellation and exhausted planning budgets',async t=>{
  let now=0;t.mock.method(performance,'now',()=>now);
  for(const kind of ['decision','interrupted']) {
    now=0;
    const {game,moves}=walkingFixture(),controller=new AbortController();
    game.move=async direction=>{
      moves.push(direction);
      game.state={...game.state,revision:1,requestId:'zero-turn-input',
        decision:kind==='decision'?{id:'real-question',kind:'confirmation'}:null,
        outcome:{status:kind,turnsElapsed:0,positionChanged:false}};
      return game.state;
    };
    const result=await new Navigator(game).go({to:{x:12,y:10},maxPlanningMs:1,signal:controller.signal,
      onStep:()=>{now=10;if(kind==='decision')controller.abort();}});
    assert.equal(result.reason,kind);assert.equal(result.actionsTaken,1);
    assert.equal(result.turnsElapsed,0);assert.equal(result.lastOperationId,'zero-turn-input');
    assert.equal(result.snapshot,game.state);assert.deepEqual(moves,['east']);
    if(kind==='decision')assert.equal(result.snapshot.decision.id,'real-question');
  }
});

test('frontier goal is chosen once despite changing nearest candidates and caller mutation',async()=>{
  const {game,queries}=walkingFixture();let selections=0;
  const frontier={x:13,y:10,distance:3};
  game.navigation=async()=>{selections++;return {frontiers:[frontier],doors:[],waysDown:[]};};
  const result=await new Navigator(game).explore({onStep:()=>{frontier.x=9;frontier.distance=1;}});
  assert.equal(result.reason,'arrived');assert.equal(selections,1);
  assert.deepEqual(result.selectedGoal,{x:13,y:10});
  assert.ok(queries.every(p=>p.x===13&&p.y===10));assert.equal(result.actionsTaken,3);
});

test('door approach stays fixed until its deliberate open and counts the verification query',async()=>{
  const {game,queries,moves}=walkingFixture(),approach={x:12,y:10},opened=[];
  let selections=0;
  game.navigation=async()=>{selections++;return {frontiers:[],waysDown:[],doors:[
    {x:12,y:9,approach,direction:'north',distance:2},
    {x:8,y:10,approach:{x:9,y:10},direction:'west',distance:3},
  ]};};
  game.open=async direction=>{opened.push(direction);game.state={...game.state,requestId:'open',
    outcome:{status:'completed',turnsElapsed:1},observation:{...game.observation,turn:game.observation.turn+1}};return game.state;};
  game.actions=async()=>({cell:{terrain:{type:'openDoor'}}});
  const result=await new Navigator(game).explore({onStep:()=>{approach.x=8;}});
  assert.equal(result.reason,'arrived');assert.equal(selections,1);
  assert.deepEqual(result.selectedGoal,{x:12,y:10});assert.deepEqual(result.endPosition,result.selectedGoal);
  assert.ok(queries.every(point=>point.x===12));assert.deepEqual(opened,['north']);
  assert.deepEqual(moves,['east','east']);assert.equal(result.actionsTaken,3);
  assert.equal(result.turnsElapsed,3);assert.equal(result.queryCount,5);
});

test('exploration cancellation during the final probe query prevents input',async()=>{
  const {game,moves}=walkingFixture(),controller=new AbortController();let queries=0;
  game.navigation=async()=>({frontiers:[],waysDown:[],doors:[]});
  game.actions=async()=>{
    if(++queries===2)controller.abort();
    return {cell:{movement:{relation:'adjacent',intent:'unknown'},actions:[{method:'game.move',arguments:{direction:'north'}}]}};
  };
  const result=await new Navigator(game).explore({signal:controller.signal});
  assert.equal(result.reason,'aborted');assert.equal(result.queryCount,3);
  assert.equal(result.actionsTaken,0);assert.deepEqual(moves,[]);
  assert.deepEqual(result.selectedGoal,{x:10,y:9});
});

test('edge fallback planning stops at its query budget deadline without probing unknown terrain',async t=>{
  let now=0;t.mock.method(performance,'now',()=>now);
  const {game,moves}=walkingFixture();
  game.state.observation.world=[{x:20,y:10,terrain:{type:'floor'}},{x:21,y:10,terrain:{type:'floor'}}];
  game.navigation=async()=>({frontiers:[],doors:[],waysDown:[]});
  game.actions=async()=>({cell:{movement:{relation:'adjacent',intent:'unknown',knownRestriction:'blocked'},actions:[]}});
  game.route=async()=>{now+=5;return {distance:4,steps:[{direction:'east'}]};};
  const result=await new Navigator(game).explore({maxPlanningMs:5});
  assert.equal(result.reason,'planningLimit');assert.equal(result.queryCount,10);
  assert.equal(result.planningElapsedMs,5);assert.equal(result.actionsTaken,0);
  assert.equal(result.selectedGoal,undefined);assert.deepEqual(moves,[]);
});

test('zero-position progress stops after one input and unknown routes never force movement',async()=>{
  const {game,moves}=walkingFixture();
  game.move=async direction=>{moves.push(direction);game.state={...game.state,requestId:'bump',outcome:{status:'completed',turnsElapsed:0,positionChanged:false}};return game.state;};
  const navigator=new Navigator(game),result=await navigator.go({to:{x:12,y:10}});
  assert.equal(result.reason,'interrupted');assert.deepEqual(result.stop,{kind:'positionUnchanged'});
  assert.equal(result.actionsTaken,1);assert.equal(result.turnsElapsed,0);
  assert.deepEqual(result.startPosition,result.endPosition);assert.equal(result.lastOperationId,'bump');
  game.route=async()=>({distance:null,why:'targetUnknown'});
  const unknown=await navigator.go({to:{x:12,y:10}});
  assert.equal(unknown.reason,'noRoute');assert.equal(unknown.why,'targetUnknown');
  assert.equal(unknown.queryCount,1);assert.equal(unknown.actionsTaken,0);assert.deepEqual(moves,['east']);
});

test('one-step retreat with a visible hostile attempts movement and preserves engine interruption',async()=>{
  for(const status of ['completed','interrupted']) {
    const {game,moves}=walkingFixture(),move=game.move;
    game.state.observation.world=[{x:9,y:10,occupant:{kind:'creature',appearance:'hostile'}}];
    game.move=async direction=>{await move(direction);game.state={...game.state,outcome:{...game.state.outcome,status}};return game.state;};
    const result=await new Navigator(game).go({direction:'east'});
    assert.equal(result.reason,status==='completed'?'arrived':'interrupted');
    assert.equal(result.queryCount,1);assert.equal(result.actionsTaken,1);assert.deepEqual(moves,['east']);
    assert.deepEqual(result.selectedGoal,{x:11,y:10});
  }
});

test('query failures retain metrics and prior progress without retrying',async()=>{
  const {game,moves}=walkingFixture(),route=game.route;let reads=0;
  game.route=async to=>{if(++reads===2)throw Error('query unavailable');return route(to);};
  await assert.rejects(new Navigator(game).go({to:{x:13,y:10}}),error=>{
    assert.ok(error instanceof NavigationError);assert.equal(error.result.reason,'error');
    assert.equal(error.result.actionsTaken,1);assert.equal(error.result.queryCount,2);
    assert.equal(error.result.lastOperationId,'move-1');assert.equal(error.result.snapshot,game.state);
    return true;
  });
  assert.deepEqual(moves,['east']);
});
