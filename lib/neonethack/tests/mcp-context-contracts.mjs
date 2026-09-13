import assert from 'node:assert/strict';
import {targetRef} from '../dist/mcp/targets.js';
import {TestAgentClient as AgentClient} from './mcp-view-fixture.mjs';
const identity={name:'Context',seed:42,role:'valkyrie',race:'dwarf',gender:'female',align:'lawful'};
const mapGlyph=(map,x,y)=>map.text.split('\n')[2+y-map.bounds.y[0]][4+x-map.bounds.x[0]];
function assertMapMarks(result){
  const map=result.scene.map;if(!map)return;
  for(const creature of result.scene.entities??[])if(typeof creature.mark==='string'&&/^[!-~]$/.test(creature.mark))assert.equal(creature.mark,mapGlyph(map,creature.position.x,creature.position.y));
  for(const cell of result.scene.nearby?.cells??[])if(cell.mark!==undefined)assert.equal(cell.mark,mapGlyph(map,cell.position.x,cell.position.y));
  for(const key of ['frontiers','waysDown','doors'])for(const entry of result.scene.navigation?.[key]??[]){
    if(entry.mark!==undefined)assert.equal(entry.mark,mapGlyph(map,entry.x,entry.y),key);
  }
}
export function contextContracts(test,label,fixture){
 test(`${label}: MCP supplies revision-bound free context and does not recycle recent messages`,async t=>{
  const b=await fixture(t),requests=[],frames=[];
  const agent=new AgentClient({send:async request=>{requests.push(request);const response=await b.transport.send(request);if(request.method.startsWith('game.'))frames.push(response);return response;}});
  const start=await agent.call('create',identity),sid={sessionId:start.basis.sessionId};
  assert.equal(start.scene.navigation.status,'available');
  assert.equal(start.version,2);assert.equal(typeof start.basis.viewId,'string');
  for(const key of ['observation','state','messages','context'])assert.equal(Object.hasOwn(start,key),false);
  assert.equal(start.scene.nearby.status,'available');assert.ok(start.scene.nearby.cells.length<=9);
  assert.ok(start.scene.nearby.cells.some(c=>c.direction==='self'&&c.attempts.search==='attemptable'));
  assert.ok(start.scene.nearby.cells.every(c=>!('relation' in (c.movement??{}))&&typeof c.attempts==='object'),'nearby is one compact line per square; executable syntax stays with inspect');
  assert.ok(start.scene.map.text.includes('@')&&start.scene.map.legend['@']==='you'&&!('world' in start.scene),'the text map replaces world cells in ordinary replies');
  assert.ok(Array.isArray(start.scene.navigation.frontiers));assert.ok(start.events.length>0);
  assertMapMarks(start);
  assert.equal(start.scene.nearby.cells.find(c=>c.direction==='self')?.mark,'@');
  const inspection=await agent.call('inspect',{...sid,target:{direction:'self'}});
  assert.equal(inspection.scene.nearby.cells.find(c=>c.direction==='self').mark,mapGlyph(start.scene.map,start.scene.self.position.x,start.scene.self.position.y));
  const result=await agent.call('search',{...sid,turns:1});
  assert.equal(result.error,undefined);assert.equal(frames.length,1);
  assertMapMarks(result);
  assert.deepEqual(result.events,frames[0].events);assert.equal(result.messages,undefined);
  assert.equal(result.basis.turn,frames[0].observation.turn);assert.deepEqual(result.scene.self.position,frames[0].observation.you);
  const receipt=await b.transport.send({version:1,method:'session.receipt',params:{...sid,requestId:result.outcome.operationId}});
  assert.deepEqual(receipt,frames[0],'enrichment preserves the exact action receipt');
  const observed=await agent.call('syncState',sid);
  assert.ok(!('messages' in observed)&&!('messageScope' in observed),'syncState never carries fresh messages, so it says nothing instead of []');assert.deepEqual(observed.events,[]);
  assert.ok(Array.isArray(observed.scene.world)&&observed.scene.nearby&&observed.scene.map,'syncState is the full JSON scene plus the map');
  assertMapMarks(observed);
  assert.equal(observed.basis.turn,result.basis.turn);assert.equal(frames.length,1);
  assert.ok(requests.filter(r=>r.method==='session.navigation').every(r=>Number.isInteger(r.params.expectedRevision)));
 });
 test(`${label}: failed free enrichment never changes a successful action into an uncertain one`,async t=>{
  const b=await fixture(t);let fail=false,inputs=0;
  const agent=new AgentClient({send:async request=>{if(request.method==='session.navigation'&&fail)throw Error('free query unavailable');if(request.method.startsWith('game.'))inputs++;return b.transport.send(request);}});
  const start=await agent.call('create',identity),sid={sessionId:start.basis.sessionId};fail=true;
  const result=await agent.call('search',{...sid,turns:1});
  assert.equal(result.error,undefined);assert.equal(result.outcome.turnsElapsed,1);
  assert.equal(result.scene.navigation.status,'unavailable');assert.equal(result.scene.navigation.reason,'queryUnavailable');
  assert.equal(result.next,undefined);assert.ok(result.outcome.operationId);
  const next=await agent.call('search',{...sid,turns:1});assert.equal(next.error,undefined);assert.equal(inputs,2);
 });
 test(`${label}: attack validation returns current choices without submitting input or replaying an old outcome`,async t=>{
  const b=await fixture(t);let inputs=0;
  const agent=new AgentClient({send:request=>{if(request.method.startsWith('game.'))inputs++;return b.transport.send(request);}});
  const start=await agent.call('create',identity),sid={sessionId:start.basis.sessionId};
  const bad=await agent.call('attack',{...sid,target:{position:{x:1,y:0}}});
  assert.equal(bad.error.code,'targetOutOfScope');assert.equal(bad.outcome.submission,'rejected');assert.equal(bad.outcome.actionsTaken,0);assert.equal(bad.outcome.operationId,undefined);
  assert.deepEqual(bad.scene.self.position,start.scene.self.position);assert.equal(bad.scene.navigation.status,'available');assert.ok(!('messages' in bad));assert.equal(inputs,0);
  const stale=await agent.call('attack',{...sid,target:{ref:targetRef({...start.basis,revision:start.basis.revision+1},1,1)}});
  assert.equal(stale.error.code,'staleTarget');assert.equal(inputs,0);
  const prayer=await agent.call('pray',sid);assert.equal(prayer.control.gate,'decision');assert.equal(prayer.decision.reply.arguments.decisionId,prayer.decision.id);
  assert.equal(inputs,1);assert.equal(prayer.decision.kind,'confirmation');
  const invalid=await agent.call('answer',{...sid,value:true});assert.equal(invalid.outcome.submission,'rejected');assert.equal(invalid.error.code,'invalidParams');
  assert.equal((await agent.call('syncState',sid)).decision.id,prayer.decision.id);
 });
 test(`${label}: enrichment from another revision is discarded without adopting a newer scene`,async t=>{
  const b=await fixture(t);let change=false;
  const agent=new AgentClient({send:async request=>{const response=await b.transport.send(request);if(change&&request.method==='session.navigation')return {...response,basis:{...response.basis,revision:response.basis.revision+1}};return response;}});
  const start=await agent.call('create',identity);change=true;
  const result=await agent.call('search',{sessionId:start.basis.sessionId,turns:1});
  assert.equal(result.error,undefined);assert.equal(result.scene.navigation.status,'unavailable');assert.equal(result.scene.navigation.frontiers,undefined);
  assert.equal(result.basis.revision,start.basis.revision+1);
 });
}
