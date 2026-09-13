import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSnapshotClient} from './client.mjs';
import {createAgentHarness,bindIntent,createIntentQueue} from './harness.mjs';
import {createOperationValidators} from './operations.mjs';
import {inspect} from './inspect.mjs';

const sessionId='fixture-session',runId='fixture-run';
function frame(){return {version:1,sessionId,revision:1,ended:false,end:null,decision:null,events:[],
  outcome:{action:'get_state',status:'completed',turnsElapsed:0,positionChanged:false,effects:[]},
  observation:{turn:1,location:{id:'level-0-1',depthLabel:'Dlvl:1'},you:{x:10,y:10},
    vitals:{health:20,maxHealth:20,hunger:'not_hungry',condition:[],burden:'unencumbered'},
    inventoryKnown:true,inventory:[],here:{known:true,items:[]},
    perception:{version:1,inventory:'current',here:'current',equipment:'current'},
    world:[{x:10,y:10,visible:true,terrain:{type:'floor',freshness:'current'}},
      {x:11,y:10,visible:true,terrain:{type:'floor',freshness:'current'},
        occupant:{kind:'creature',appearance:'newt',attitude:'hostile',mark:':',color:5}}],heard:[]}};}
const request=(operation='attack',args={target:{x:11,y:10}},expectedRevision=1)=>
  ({runId,sessionId,expectedRevision,operation,args,approved:true});
async function setup(t,{initial=frame(),respond,records=()=>[]}={}){
  const runDir=await mkdtemp(join(tmpdir(),'neohack-composed-'));
  t.after(()=>rm(runDir,{recursive:true,force:true}));
  const sent=[];let current=structuredClone(initial);
  const client=createSnapshotClient({runDir,sessionId,send:async(call,context)=>{
    sent.push(structuredClone(call));
    if(call.name==="syncState")return structuredClone(current);
    if(respond)current=await respond(call,structuredClone(current),context);
    else {current.revision++;current.observation.turn++;current.outcome={action:call.name==='attack'?'attack':call.name.replace('game_',''),status:'completed',turnsElapsed:1,positionChanged:false,effects:['attacked']};}
    return structuredClone(current);
  }});
  const harness=createAgentHarness({runId,sessionId,client,operations:createOperationValidators({sessionId}),records});
  await harness.observe({deliberate:true});sent.length=0;
  return {harness,client,sent,runDir};
}

test('composed identity, public-coordinate policy and dispatcher reject eyes with zero sends',async t=>{
  const initial=frame();initial.observation.world[1].occupant.appearance='floating eye';
  const {harness,sent}=await setup(t,{initial});
  await assert.rejects(harness.dispatch(request()));assert.equal(sent.length,0);
});
test('malformed creature coordinates cannot pass the composed guard',async t=>{
  const initial=frame();initial.creatures=[{appearance:'floating eye',position:{x:'11',y:10}}];
  const {harness,sent}=await setup(t,{initial});
  await assert.rejects(harness.dispatch(request()));assert.equal(sent.length,0);
});
test('wrong run, stale revision and invalid generated arguments fail before input',async t=>{
  const {harness,sent}=await setup(t);
  for(const intent of [{...request(),runId:'other'},request('attack',{target:{x:11,y:10}},0),
    request('attack',{target:{x:11,y:10},unknown:true})])await assert.rejects(harness.dispatch(intent));
  assert.equal(sent.length,0);
});
test('one explicitly selected ordinary attack emits one validated call, no local identity wire fields',async t=>{
  const {harness,sent}=await setup(t);const result=await harness.dispatch(request());
  assert.equal(result.state.revision,2);assert.equal(sent.length,1);
  assert.deepEqual(sent[0],{name:'attack',arguments:{target:{x:11,y:10},sessionId}});
});
test('fresh zero-turn bump blocks; rolling heard alone does not invent fresh evidence',async t=>{
  const initial=frame();initial.observation.heard=['You move right into the floating eye.'];
  const bump=structuredClone(initial);bump.outcome={action:'moveWithoutAttack',status:'completed',turnsElapsed:0,positionChanged:false,effects:[]};
  bump.events=[{type:'heard',text:initial.observation.heard[0]}];
  let records=[{request:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:"moveWithoutAttack",arguments:{sessionId,direction:'east'}}},response:{jsonrpc:'2.0',id:1,result:{structuredContent:bump}}}];
  const {harness,sent}=await setup(t,{initial,records:()=>records});
  await assert.rejects(harness.dispatch(request()));assert.equal(sent.length,0);
  records=[];await harness.dispatch(request());assert.equal(sent.length,1);
});
test('non-melee retreat stays available beside an eye as an explicit attempt',async t=>{
  const initial=frame();initial.observation.world[1].occupant.appearance='floating eye';
  const {harness,sent}=await setup(t,{initial});
  await harness.dispatch(request("moveWithoutAttack",{direction:'west'}));assert.equal(sent.length,1);
});
test('exact item reference survives presentation and selection; guessed slot never dispatches',async t=>{
  const initial=frame();initial.observation.inventory=[{id:'opaque-ration',label:'a food ration',location:'inventory',quantity:1,actions:['eat'],usage:[],equipmentSlots:[]}];
  const {harness,sent}=await setup(t,{initial});
  const view=await harness.view();assert.equal(view.items.inventory.items[0].id,'opaque-ration');
  await assert.rejects(harness.dispatch(request("eat",{itemId: 'item-f'})));assert.equal(sent.length,0);
  await harness.dispatch(request("eat",{itemId: 'opaque-ration'}));assert.equal(sent.length,1);
});
test('exact standing decisions remain explicit and are not bypassed by ordinary play',async t=>{
  const initial=frame();initial.decision={id:'exact-question',kind:'confirmation',action:'pray',cancellable:true};
  const {harness,sent}=await setup(t,{initial});
  await assert.rejects(harness.dispatch(request()));
  await assert.rejects(harness.dispatch(request("answer",{decisionId:'old',value: true})));
  assert.equal(sent.length,0);
  await harness.dispatch(request("answer",{decisionId:'exact-question',value: true}));assert.equal(sent.length,1);
});
test('hunger change after progress stops a walking leg and prevents another automatic leg',async t=>{
  const initial=frame();delete initial.observation.world[1].occupant;
  const {harness,sent}=await setup(t,{initial,respond:(call,s)=>{s.revision++;s.observation.turn++;s.observation.you={x:11,y:10};s.observation.vitals.hunger='fainting';s.navigation={reason:'changed',actionsTaken:1,turnsElapsed:1};s.outcome={action:'move',status:'completed',turnsElapsed:1,positionChanged:true,effects:['moved']};return s;}});
  const first=await harness.walk({intent:'food',to:{x:12,y:10},maxActions:3});
  assert.equal(first.reason,'hungerChanged');assert.equal(sent.length,1);
  const next=await harness.walk({intent:'food',to:{x:12,y:10},maxActions:3});
  assert.equal(next.reason,'triage');assert.equal(sent.length,1);
});
test('unchanged failed target keeps its retry budget across walk invocations',async t=>{
  const initial=frame();delete initial.observation.world[1].occupant;
  const {harness,sent}=await setup(t,{initial,respond:(call,s)=>{s.revision++;s.navigation={reason:'noRoute',actionsTaken:0,turnsElapsed:0};return s;}});
  assert.equal((await harness.walk({intent:'east',to:{x:11,y:10},maxActions:1})).reason,'noRoute');
  const next=await harness.walk({intent:'east',to:{x:11,y:10},maxActions:1});
  assert.equal(next.calls,1);assert.equal(sent.length,1); // callback stopped locally; no second wire call
  assert.ok(next.stops[0].error.evidence.reason==='noProgress');
});
test('a stable walking intent retains its original level after a level transition',async t=>{
  const initial=frame();delete initial.observation.world[1].occupant;
  const {harness,sent}=await setup(t,{initial,respond:(call,s)=>{s.revision++;s.observation.turn++;s.observation.location={id:'level-0-2',depthLabel:'Dlvl:2'};s.navigation={reason:'changed',actionsTaken:1,turnsElapsed:1};return s;}});
  assert.equal((await harness.walk({intent:'east',to:{x:11,y:10},maxActions:1})).reason,'levelChanged');
  assert.equal((await harness.walk({intent:'east',to:{x:11,y:10},maxActions:1})).reason,'levelChanged');
  assert.equal(sent.length,1);
});
test('viewing an empty store and explicitly refreshing a failed read do not wedge liveness',async t=>{
  const runDir=await mkdtemp(join(tmpdir(),'neohack-composed-read-'));t.after(()=>rm(runDir,{recursive:true,force:true}));
  let reads=0;const client=createSnapshotClient({runDir,sessionId,send:async()=>{if(++reads===1)throw Error('lost observation');return frame();}});
  const harness=createAgentHarness({runId,sessionId,client,operations:createOperationValidators({sessionId})});
  assert.equal((await harness.view()).lifecycle.state,'unknown');
  await assert.rejects(harness.observe({deliberate:true}));
  assert.equal(harness.lifecycle.status().state,'disconnected');
  await harness.observe({deliberate:true});assert.equal(harness.lifecycle.status().state,'alive');assert.equal(reads,2);
  await assert.rejects(harness.recover({deliberate:true}));assert.equal(harness.lifecycle.status().state,'alive');
});
test('historical response is retained as evidence and never fed to current lifecycle or continuation',async t=>{
  const {harness,sent,client}=await setup(t,{respond:(call,s)=>{s.historical=true;return s;}});
  await assert.rejects(harness.dispatch(request()),{code:'CURRENT_STATE_REQUIRED'});
  assert.equal((await client.readSnapshot({requireCurrent:false})).status,'needs-observation');
  assert.equal(harness.lifecycle.status().state,'disconnected');assert.equal(sent.length,1);
});
test('target-bound intent queue stops after kill instead of attacking the emptied square',async t=>{
  const initial=frame();
  const bound=bindIntent(initial,{action:'attack',target:{kind:'creature',x:11,y:10},goal:'clear passage',maxActions:3});
  assert.equal(bound.allowed,true);const queue=createIntentQueue(bound.intent);
  const {harness,sent}=await setup(t,{initial,respond:(call,s)=>{s.revision++;s.observation.turn++;delete s.observation.world[1].occupant;s.outcome={action:'attack',status:'completed',turnsElapsed:1,positionChanged:false,effects:['attacked']};return s;}});
  assert.equal((await harness.executeIntent(queue,{goal:'clear passage'})).continuation.reason,'targetDisappeared');
  assert.equal((await harness.executeIntent(queue,{goal:'clear passage'})).allowed,false);assert.equal(sent.length,1);
});
test('terminal response cancels polling, blocks mutations and keeps deliberate inspection',async t=>{
  const {harness,sent,runDir}=await setup(t,{respond:(call,s)=>{s.revision++;s.ended=true;s.end={kind:'death',turn:s.observation.turn,cause:'fixture death'};return s;}});
  let canceled=0;harness.lifecycle.registerPlayJob(()=>canceled++);
  await harness.dispatch(request());assert.equal(canceled,1);
  await assert.rejects(harness.dispatch(request("wait",{},2)));assert.equal(sent.length,1);
  await assert.rejects(harness.observe());assert.equal(sent.length,1);
  const output=await inspect(join(runDir,'state.json'));assert.equal(output.exitCode,20);assert.match(output.text,/fixture death/);
});
test('uncertain transport keeps durable pending input and prevents new actions or observe recovery',async t=>{
  const {harness,sent,runDir}=await setup(t,{respond:()=>{throw Error('lost response')}});
  await assert.rejects(harness.dispatch(request()));
  await assert.rejects(harness.dispatch(request()));
  await assert.rejects(harness.observe({deliberate:true}));assert.equal(sent.length,1);
  const state=JSON.parse(await readFile(join(runDir,'state.json'),'utf8'));
  assert.equal(state.status,'uncertain');assert.equal(state.pendingRequest.name,'attack');
});
