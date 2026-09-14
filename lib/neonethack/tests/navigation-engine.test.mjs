import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './native-fixture.mjs';
import {scenarioEngine} from './pickup-engine-fixture.mjs';
import {Neonethack} from '../dist/typescript/client.js';
import {WasmTransport} from '../dist/typescript/wasm.js';
import {McpService} from '../dist/mcp/service.js';

for(const wasm of [false,true])test(`${wasm?'WASM':'native'} travel descent success includes actual engine climb and new level`,async t=>{
  const options=await scenarioEngine(t,wasm,'descent-fixture.inc','descent_fixture');
  const transport=wasm?await WasmTransport.create(options):(await fixture(t,options)).transport;
  if(wasm)t.after(()=>transport.close());
  const inputs=[],service=new McpService({send:async request=>{
    if(request.method.startsWith('game.'))inputs.push(request);
    return transport.send(request);
  }});
  const call=async(name,args)=>{
    const reply=await service.call(name,args);
    assert.equal(reply.isError,false,reply.structuredContent.error?.message);
    return reply.structuredContent;
  };
  for(const stopAtStairs of [false,true]){
    const created=await call('session',{action:'create',name:'Descender',seed:42,role:'valkyrie',race:'dwarf',gender:'female',align:'lawful'});
    const sessionId=created.basis.sessionId,level=created.basis.levelId;
    inputs.length=0;
    let view=created;
    if(stopAtStairs){
      view=await call('travel',{sessionId,viewId:view.basis.viewId,mode:'descend',maxActions:1});
      assert.equal(view.result.reason,'stepLimit');assert.equal(view.basis.levelId,level);
      assert.deepEqual(inputs.map(r=>r.method),['game.move']);
    }
    const result=await call('travel',{sessionId,viewId:view.basis.viewId,mode:'descend',maxActions:stopAtStairs?1:2});
    assert.equal(result.result.reason,'arrived');
    assert.notEqual(result.basis.levelId,level);
    assert.deepEqual(result.result.stop,{kind:'levelChanged',before:level,after:result.basis.levelId});
    assert.equal(result.outcome.positionChanged,true);
    assert.equal(result.result.actionsTaken,stopAtStairs?1:2);
    assert.deepEqual(inputs.map(r=>r.method),['game.move','game.climb']);
    assert.equal(inputs.at(-1).params.direction,'down');
    const receipt=await transport.send(inputs.at(-1));
    assert.equal(receipt.observation.location.id,result.basis.levelId);
    assert.equal(receipt.requestId,result.outcome.operationId);
    await call('session',{sessionId,action:'suspend'});
    const resumed=await call('session',{sessionId,action:'resume'});
    assert.equal(resumed.basis.levelId,result.basis.levelId);
  }
});

for(const wasm of [false,true])test(`${wasm?'WASM':'native'} navigator retreats from a visible hostile with one ordinary input`,async t=>{
  const options=await scenarioEngine(t,wasm,'manual-fixture.inc','manual_fixture');
  let api,transport;
  if(wasm) {
    transport=await WasmTransport.create(options);t.after(()=>transport.close());
    api=new Neonethack(transport);
  } else ({api,transport}=await fixture(t,options));
  const game=await api.create({name:'RunCreature',seed:42,role:'valkyrie',race:'dwarf',gender:'female',align:'lawful'});
  const before=game.observation;
  assert.deepEqual(before.you,{x:40,y:10});
  const hostile=before.world.find(cell=>cell.x===39&&cell.y===10)?.occupant;
  assert.equal(hostile?.kind,'creature');assert.equal(hostile?.attitude,'hostile');
  const send=transport.send.bind(transport),inputs=[];
  transport.send=async request=>{
    if(request.method.startsWith('game.'))inputs.push(request);
    return send(request);
  };
  await assert.rejects(game.go({direction:'west'}),/go never attacks/);
  assert.deepEqual(inputs,[],'a displayed hostile target is never attacked implicitly');
  const result=await game.go({direction:'east'});
  assert.equal(result.reason,'arrived');assert.equal(result.actionsTaken,1);
  assert.equal(result.turnsElapsed,1);assert.equal(result.queryCount,1);
  assert.deepEqual(result.startPosition,before.you);
  assert.deepEqual(result.endPosition,{x:41,y:10});
  assert.deepEqual(result.selectedGoal,result.endPosition);
  assert.equal(result.snapshot,game.state);assert.equal(result.snapshot.outcome.status,'completed');
  assert.deepEqual(inputs.map(request=>request.method),['game.move']);
  assert.equal(result.snapshot.requestId,inputs[0].params.requestId);
  const receipt=await transport.send(inputs[0]);
  assert.deepEqual(receipt,result.snapshot,'replaying the exact accepted request returns its receipt');
  await game.observe();assert.equal(game.observation.turn,before.turn+1,'receipt verification never repeats movement');
});
