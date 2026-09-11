import assert from 'node:assert/strict';
import {AgentClient} from '../dist/mcp/agent.js';
const identity={name:'Context',seed:42,role:'valkyrie',race:'dwarf',gender:'female',align:'lawful'};
const messages=frame=>frame.events.filter(e=>(e.type==='heard'||e.type==='passage')&&e.text?.trim()).map(e=>({turn:frame.observation.turn,text:e.text}));
export function contextContracts(test,label,fixture){
 test(`${label}: MCP supplies revision-bound free context and does not recycle recent messages`,async t=>{
  const b=await fixture(t),requests=[],frames=[];
  const agent=new AgentClient({send:async request=>{requests.push(request);const response=await b.transport.send(request);if(request.method.startsWith('game.'))frames.push(response);return response;}});
  const start=await agent.call('create',identity),sid={sessionId:start.sessionId};
  assert.equal(start.context.status,'available');
  for(const key of ['state','messages','context'])assert.ok(Object.keys(start).indexOf(key)<Object.keys(start).indexOf('observation'));assert.equal(start.context.revision,start.revision);
  assert.equal(start.context.nearby.status,'available');assert.ok(start.context.nearby.cells.length<=9);
  assert.ok(start.context.nearby.cells.some(c=>c.movement.relation==='here'));
  assert.ok(Array.isArray(start.context.frontiers));assert.ok(start.messages.length>0);
  const result=await agent.call('search',{...sid,turns:1});
  assert.equal(result.error,undefined);assert.equal(frames.length,1);
  assert.deepEqual(result.messages,messages(frames[0]));assert.equal(result.messageScope,'action');
  assert.equal(result.state.turn,frames[0].observation.turn);assert.deepEqual(result.state.position,frames[0].observation.you);
  const receipt=await b.transport.send({version:1,method:'session.receipt',params:{...sid,requestId:result.operationId}});
  assert.deepEqual(receipt,frames[0],'enrichment preserves the exact action receipt');
  const observed=await agent.call('observe',sid);
  assert.deepEqual(observed.messages,[]);assert.deepEqual(observed.events,[]);assert.equal(observed.messageScope,'observation');
  assert.equal(observed.state.turn,result.state.turn);assert.equal(frames.length,1);
  assert.ok(requests.filter(r=>r.method==='session.navigation').every(r=>Number.isInteger(r.params.expectedRevision)));
 });
 test(`${label}: failed free enrichment never changes a successful action into an uncertain one`,async t=>{
  const b=await fixture(t);let fail=false,inputs=0;
  const agent=new AgentClient({send:async request=>{if(request.method==='session.navigation'&&fail)throw Error('free query unavailable');if(request.method.startsWith('game.'))inputs++;return b.transport.send(request);}});
  const start=await agent.call('create',identity),sid={sessionId:start.sessionId};fail=true;
  const result=await agent.call('search',{...sid,turns:1});
  assert.equal(result.error,undefined);assert.equal(result.outcome.turnsElapsed,1);
  assert.equal(result.context.status,'unavailable');assert.equal(result.context.reason,'queryUnavailable');
  assert.equal(result.next,undefined);assert.ok(result.operationId);
  const next=await agent.call('search',{...sid,turns:1});assert.equal(next.error,undefined);assert.equal(inputs,2);
 });
 test(`${label}: attack validation returns current choices without submitting input or replaying an old outcome`,async t=>{
  const b=await fixture(t);let inputs=0;
  const agent=new AgentClient({send:request=>{if(request.method.startsWith('game.'))inputs++;return b.transport.send(request);}});
  const start=await agent.call('create',identity),sid={sessionId:start.sessionId};
  const bad=await agent.call('attack',{...sid,target:{x:1,y:0}});
  assert.equal(bad.error.code,'notAdjacent');assert.equal(bad.inputSubmitted,false);assert.equal(bad.outcome,undefined);assert.equal(bad.operationId,undefined);
  assert.deepEqual(bad.error.position,start.state.position);assert.equal(bad.context.status,'available');assert.deepEqual(bad.messages,[]);assert.equal(inputs,0);
  const stale=await agent.call('attack',{...sid,target:'not-a-current-creature'});
  assert.equal(stale.error.code,'staleTarget');assert.equal(inputs,0);
  const prayer=await agent.call('pray',sid);assert.equal(prayer.context.status,'decision');assert.equal(prayer.reply.arguments.decisionId,prayer.decision.id);
  assert.equal(inputs,1);assert.equal(prayer.decision.kind,'confirmation');
  const invalid=await agent.call('answer',{...sid,value:true});assert.equal(invalid.inputSubmitted,false);assert.ok(invalid.tool.inputSchema.required.includes('decisionId'));
  assert.equal((await agent.call('observe',sid)).decision.id,prayer.decision.id);
 });
 test(`${label}: enrichment from another revision is discarded without adopting a newer scene`,async t=>{
  const b=await fixture(t);let change=false;
  const agent=new AgentClient({send:async request=>{const response=await b.transport.send(request);if(change&&request.method==='session.navigation')return {...response,basis:{...response.basis,revision:response.basis.revision+1}};return response;}});
  const start=await agent.call('create',identity);change=true;
  const result=await agent.call('search',{sessionId:start.sessionId,turns:1});
  assert.equal(result.error,undefined);assert.equal(result.context.status,'unavailable');assert.equal(result.context.frontiers,undefined);
  assert.equal(result.state.revision,result.revision);
 });
}
