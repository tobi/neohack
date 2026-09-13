import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './native-fixture.mjs';
import {scenarioEngine} from './pickup-engine-fixture.mjs';
import {Neonethack} from '../dist/typescript/client.js';
import {WasmTransport} from '../dist/typescript/wasm.js';

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
