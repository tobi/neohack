import {test} from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv/dist/2020.js';
import {fixture,identity} from './native-fixture.mjs';
import {McpService} from '../dist/mcp/service.js';
import {mcpResponseSchema} from '../dist/mcp/protocol-data.js';
import {SceneReader} from '../dist/mcp/scene.js';
import {present} from '../dist/mcp/frame.js';
const validate=new Ajv({strict:false}).compile(mcpResponseSchema);

test('decision-first frames expose explicit gates, current syntax, stale rejection and receipt recovery',async t=>{
  const f=await fixture(t),requests=[];
  let lose=false;
  const service=new McpService({send:async r=>{requests.push(r);const result=await f.transport.send(r);if(lose&&r.method==='game.wait'){lose=false;throw Error('simulated lost reply');}return result;}});
  const call=async(name,args={})=>{
    const result=await service.call(name,args),frame=result.structuredContent;
    assert.ok(validate(frame),JSON.stringify(validate.errors));
    for(const key of ['state','observation','messages','context','reply','sessionId','revision','operationId'])assert.equal(Object.hasOwn(frame,key),false,key);
    return frame;
  };
  let frame=await call('create',identity);
  const sid={sessionId:frame.basis.sessionId},first=frame.basis.viewId;
  assert.equal(frame.control.gate,'ready');assert.equal(frame.scene.world,undefined);
  assert.ok(frame.scene.map.text.includes('@'));assert.ok(frame.scene.navigation.frontiers.length);
  const missing=await call('wait',sid);assert.equal(missing.outcome.submission,'rejected');
  assert.equal(requests.filter(r=>r.method==='game.wait').length,0);
  frame=await call('pray',{...sid,viewId:first});
  assert.equal(frame.control.gate,'decision');assert.equal(frame.decision.reply.valueSchema.type,'boolean');
  assert.deepEqual(frame.decision.reply.arguments,{...sid,decisionId:frame.decision.id});
  const before=requests.length;
  const blocked=await call('go',{...sid,viewId:frame.basis.viewId,to:{x:1,y:1}});
  assert.equal(blocked.error.code,'pendingDecision');assert.equal(blocked.control.decisionId,frame.decision.id);
  assert.equal(requests.length,before,'a pending question does not execute or replan');
  const turn=frame.basis.turn;
  frame=await call('answer',{...frame.decision.reply.arguments,value:false});
  assert.equal(frame.control.gate,'ready');assert.equal(frame.basis.turn,turn);
  assert.notEqual(frame.basis.viewId,first);
  const stale=await call('wait',{...sid,viewId:first});assert.equal(stale.error.code,'staleView');
  lose=true;
  const lost=await call('wait',{...sid,viewId:frame.basis.viewId});
  assert.equal(lost.control.gate,'recoveryRequired');assert.equal(lost.outcome.submission,'unknown');
  const count=requests.filter(r=>r.method==='game.wait').length;
  frame=await call('syncState',sid);
  assert.equal(frame.verification.status,'settled');assert.equal(frame.control.gate,'ready');
  assert.equal(requests.filter(r=>r.method==='game.wait').length,count,'recovery never resends');
  assert.ok(frame.scene.world.length);assert.deepEqual(frame.events,[]);
});

test('full per-action scenes and opt-in deltas materialize without compensating syncState',async t=>{
  const f=await fixture(t),service=new McpService(f.transport),reader=new SceneReader();
  let frame=reader.apply((await service.call('create',{...identity,includeWorld:true})).structuredContent);
  const initial=frame.basis;
  const result=(await service.call('wait',{sessionId:initial.sessionId,viewId:initial.viewId,includeWorld:true,sinceViewId:initial.viewId})).structuredContent;
  assert.ok(validate(result),JSON.stringify(validate.errors));assert.equal(result.scene.kind,'delta');
  frame=reader.apply(result);assert.equal(frame.scene.kind,'snapshot');assert.ok(frame.scene.world.length);
  assert.ok(frame.basis.turn>initial.turn);
  const synced=(await service.call('syncState',{sessionId:initial.sessionId})).structuredContent;
  assert.deepEqual(frame.scene.world,synced.scene.world);assert.deepEqual(synced.events,[]);
});

test('navigation position change covers the whole leg, including a stationary final input',async t=>{
  const {api}=await fixture(t),game=await api.create(identity);
  const snapshot=structuredClone(game.state),origin={...snapshot.observation.you};
  const away={x:origin.x+1,y:origin.y};
  const cases=[
    {name:'walk then open a door',lastMoved:false,start:origin,end:away,actions:2,expected:true},
    {name:'walk then an interrupted stationary step',lastMoved:false,start:origin,end:away,actions:2,reason:'interrupted',expected:true},
    {name:'return to origin',lastMoved:true,start:origin,end:origin,actions:2,expected:false},
    {name:'zero-action result after a prior move',lastMoved:true,start:origin,end:origin,actions:0,expected:false},
    {name:'missing endpoint is not the last input',lastMoved:true,start:origin,actions:1,expected:false},
    {name:'explicit level change at matching coordinates',lastMoved:false,start:origin,end:origin,actions:1,
      stop:{kind:'levelChanged',before:'level-0-1',after:'level-0-2'},expected:true},
  ];
  for(const entry of cases){
    snapshot.outcome.positionChanged=entry.lastMoved;
    const navigation={reason:entry.reason??'arrived',actionsTaken:entry.actions,turnsElapsed:entry.actions,
      startPosition:entry.start,...(entry.end?{endPosition:entry.end}:{}),...(entry.stop?{stop:entry.stop}:{}),queryCount:1,planningElapsedMs:0};
    const before=structuredClone(snapshot),frame=present(snapshot,{navigation});
    assert.equal(frame.outcome.positionChanged,entry.expected,entry.name);
    assert.equal(frame.outcome.actionsTaken,entry.actions);assert.equal(frame.outcome.turnsElapsed,entry.actions);
    assert.deepEqual(snapshot,before,'projection preserves the low engine receipt');
    assert.equal(present(snapshot,{navigation,readOnly:true}).outcome.positionChanged,false);
    assert.equal(present(snapshot,{navigation,rejected:true}).outcome.positionChanged,false);
  }
  snapshot.outcome.positionChanged=true;
  assert.equal(present(snapshot).outcome.positionChanged,true,'ordinary actions still use their engine outcome');
});

test('repeatedIntent counts A-B-A reads on the same view without submitting engine input',async t=>{
  const f=await fixture(t),requests=[];
  const service=new McpService({send:request=>{requests.push(request);return f.transport.send(request);}});
  const created=(await service.call('create',identity)).structuredContent;
  const sid={sessionId:created.basis.sessionId};
  const before=requests.length;
  const first=(await service.call('inspect',{...sid,target:{direction:'self'}})).structuredContent;
  const other=(await service.call('inspect',{...sid,target:{direction:'north'}})).structuredContent;
  const repeated=(await service.call('inspect',{...sid,target:{direction:'self'}})).structuredContent;
  for(const frame of [first,other,repeated]){
    assert.equal(frame.error,undefined);assert.equal(frame.basis.viewId,created.basis.viewId);
    assert.equal(frame.outcome.actionsTaken,0);assert.equal(frame.outcome.turnsElapsed,0);
    assert.equal(frame.outcome.submission,'notSubmitted');
  }
  assert.equal(first.diagnostics.repeatedIntent,0);assert.equal(other.diagnostics.repeatedIntent,0);
  assert.equal(repeated.diagnostics.repeatedIntent,1);
  assert.ok(requests.slice(before).every(request=>!request.method.startsWith('game.')&&!request.method.startsWith('decision.')&&request.method!=='session.create'),
    'all three reads remain free and never submit gameplay');
});
