import test from 'node:test';
import assert from 'node:assert/strict';
import {createDecisionClient} from './decision-client.mjs';
import {agentTools} from '../../lib/neonethack/protocol/agent.ts';

const frame=(revision=1,extra={})=>({version:2,basis:{sessionId:'run',revision,viewId:`view-${revision}`,levelId:'level',turn:1},
  control:{gate:'ready'},outcome:{submission:'accepted',status:'completed',actionsTaken:1,turnsElapsed:0},
  scene:{kind:'snapshot',self:{position:{x:1,y:1}},entities:[],features:[],inventory:[]},decision:null,events:[],...extra});
function setup(send=async()=>frame(2)) {
  const sent=[];
  const client=createDecisionClient({sessionId:'run',tools:agentTools,reader:{apply:structuredClone},
    send:async call=>{sent.push(call);return send(call);}});
  client.accept(frame());return {client,sent};
}
test('one mutation preserves explicit view, returns compact scene and never adds a sync',async()=>{
  const {client,sent}=setup();
  const reply=await client.call({name:'step',arguments:{viewId:'view-1',target:{direction:'east'}}});
  assert.equal(reply.basis.revision,2);assert.equal(reply.basis.turn,1);
  assert.deepEqual(sent,[{name:'step',arguments:{sessionId:'run',viewId:'view-1',target:{direction:'east'}}}]);
  assert.equal(reply.scene.world,undefined);
  await assert.rejects(client.call({name:'wait',arguments:{viewId:'view-1'}}),/viewId/);
  await assert.rejects(client.call({name:'wait',arguments:{}}),/viewId/);
  assert.equal(sent.length,1);
});
test('queued calls retain their submitted view and cannot acquire the preceding result view',async()=>{
  const {client,sent}=setup();
  const first=client.call({name:'wait',arguments:{viewId:'view-1'}});
  const second=client.call({name:'wait',arguments:{viewId:'view-1'}});
  await first;await assert.rejects(second,/viewId/);assert.equal(sent.length,1);
});
test('decision replies bind exact IDs and permitted cancellation',async()=>{
  const {client,sent}=setup();
  client.accept(frame(1,{control:{gate:'decision'},decision:{id:'question-1',reply:{tool:'answer'}}}));
  await assert.rejects(client.call({name:'wait',arguments:{viewId:'view-1'}}),/decision/);
  await assert.rejects(client.call({name:'answer',arguments:{decisionId:'old',value:false}}),/exact/);
  await assert.rejects(client.call({name:'cancel',arguments:{decisionId:'question-1'}}),/cancellation/);
  assert.equal(sent.length,0);
  await client.call({name:'answer',arguments:{decisionId:'question-1',value:false}});
  assert.deepEqual(sent[0].arguments,{sessionId:'run',decisionId:'question-1',value:false});
});
test('lost responses block input and ordinary queries cannot clear uncertainty',async()=>{
  let calls=0;
  const {client,sent}=setup(async()=>{if(++calls===1)throw Error('lost');return frame(2);});
  await assert.rejects(client.call({name:'wait',arguments:{viewId:'view-1'}}),/lost/);
  await client.call({name:'syncState',arguments:{}});
  await assert.rejects(client.call({name:'wait',arguments:{viewId:'view-2'}}),/blocked/);
  assert.equal(sent.length,2);assert.equal(client.blocked(),true);
});
test('historical result is not adopted and legacy replies fail closed',async()=>{
  const {client}=setup(async()=>frame(1,{basis:null,scene:null,result:{kind:'receipt',receipt:{version:1,revision:100}}}));
  await client.call({name:'receipt',arguments:{operationId:'op'}});
  assert.equal(client.current().basis.revision,1);
  assert.throws(()=>client.accept({version:1,observation:{}}),/v2/);
  assert.throws(()=>client.accept(frame(2,{basis:{sessionId:'other'}})),/session/);
});
test('ownership loss and terminal gates stop input without a transport call',async()=>{
  for(const gate of ['ended','ownershipLost','recoveryRequired','unavailable']){
    const {client,sent}=setup();client.accept(frame(1,{control:{gate}}));
    await assert.rejects(client.call({name:'wait',arguments:{viewId:'view-1'}}),/blocked/);
    assert.equal(sent.length,0);
  }
});
test('only explicit settled verification clears a lost call; cancellation preserves its exact ID',async()=>{
  let count=0;
  const {client,sent}=setup(async()=>{
    if(++count===1)throw Error('lost');
    return frame(count,{verification:{status:'settled'}});
  });
  await assert.rejects(client.call({name:'wait',arguments:{viewId:'view-1'}}),/lost/);
  await client.call({name:'syncState',arguments:{}});
  assert.equal(client.blocked(),false);
  client.accept(frame(3,{control:{gate:'decision'},decision:{id:'question-3',cancel:{tool:'cancel'}}}));
  await client.call({name:'cancel',arguments:{decisionId:'question-3'}});
  assert.deepEqual(sent.at(-1).arguments,{sessionId:'run',decisionId:'question-3'});
});
test('scene-less ownership loss cannot leave an earlier ready scene authorizing input',async()=>{
  const {client,sent}=setup(async()=>frame(1,{basis:null,scene:null,control:{gate:'ownershipLost'}}));
  await client.call({name:'syncState',arguments:{sessionId:'run'}});
  await assert.rejects(client.call({name:'wait',arguments:{sessionId:'run',viewId:'view-1'}}),/blocked/);
  assert.equal(sent.length,1);
});
for (const name of ['inspect','syncState']) {
  test(`lost ${name} needs a fresh scene, not an input receipt or mutation retry`,async()=>{
    let calls=0;
    const {client,sent}=setup(async()=>{
      if(++calls===1)throw Error('lost read');
      return frame(calls);
    });
    await assert.rejects(client.call({name,arguments:{}}),/lost read/);
    assert.equal(client.recovery(),'scene');assert.equal(client.blocked(),true);
    await assert.rejects(client.call({name:'wait',arguments:{viewId:'view-1'}}),/blocked/);
    // An unrelated successful read cannot silently refresh action authority.
    await client.call({name:'inspect',arguments:{}});
    await assert.rejects(client.call({name:'wait',arguments:{viewId:'view-2'}}),/blocked/);
    const fresh=await client.call({name:'syncState',arguments:{}});
    assert.equal(fresh.verification,undefined);
    assert.equal(client.recovery(),null);assert.equal(client.blocked(),false);
    await client.call({name:'wait',arguments:{viewId:fresh.basis.viewId}});
    assert.deepEqual(sent.map(call=>call.name),[name,'inspect','syncState','wait']);
  });
}
for (const gate of ['unavailable','ready']) {
  test(`rejected staleView with ${gate} gate can recover by explicit sync without receipt verification`,async()=>{
    let calls=0;
    const {client,sent}=setup(async()=>++calls===1?frame(1,{
      scene:null,control:{gate},outcome:{submission:'rejected',status:'blocked',actionsTaken:0},
      error:{code:'staleView'},
    }):frame(calls));
    await client.call({name:'wait',arguments:{viewId:'view-1'}});
    assert.equal(client.recovery(),'scene');
    await assert.rejects(client.call({name:'wait',arguments:{viewId:'view-1'}}),/blocked/);
    const fresh=await client.call({name:'syncState',arguments:{}});
    assert.equal(fresh.verification,undefined);assert.equal(client.blocked(),false);
    await client.call({name:'step',arguments:{viewId:fresh.basis.viewId,target:{direction:'east'}}});
    assert.deepEqual(sent.map(call=>call.name),['wait','syncState','step']);
  });
}
test('failed reads and unavailable scenes cannot erase a pending mutation receipt',async()=>{
  let calls=0;
  const {client,sent}=setup(async()=>{
    if(++calls<=2)throw Error('lost');
    if(calls===3)return frame(1,{scene:null,control:{gate:'unavailable'},outcome:{submission:'notSubmitted'},error:{code:'staleView'}});
    return frame(2);
  });
  await assert.rejects(client.call({name:'wait',arguments:{viewId:'view-1'}}),/lost/);
  await assert.rejects(client.call({name:'inspect',arguments:{}}),/lost/);
  await client.call({name:'syncState',arguments:{}});
  await client.call({name:'syncState',arguments:{}});
  assert.equal(client.recovery(),'receipt');assert.equal(client.blocked(),true);
  await assert.rejects(client.call({name:'wait',arguments:{viewId:'view-2'}}),/blocked/);
  assert.deepEqual(sent.map(call=>call.name),['wait','inspect','syncState','syncState']);
});
test('missing or erroneous sync scenes do not repair a failed read',async()=>{
  let calls=0;
  const {client}=setup(async()=>{
    if(++calls===1)throw Error('lost read');
    return calls===2?frame(1,{scene:null}):frame(2,{error:{code:'readFailed'}});
  });
  await assert.rejects(client.call({name:'inspect',arguments:{}}),/lost read/);
  for(let i=0;i<2;i++){
    await client.call({name:'syncState',arguments:{}});
    assert.equal(client.recovery(),'scene');
    await assert.rejects(client.call({name:'wait',arguments:{viewId:client.current().basis.viewId}}),/blocked/);
  }
});
