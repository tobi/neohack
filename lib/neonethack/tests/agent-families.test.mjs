import {test} from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv/dist/2020.js';
import {fixture,identity} from './native-fixture.mjs';
import {WasmTransport} from '../dist/typescript/wasm.js';
import {AgentClient} from '../dist/mcp/agent.js';
import {tools,readOnlyTools} from '../dist/mcp/agent-data.js';
import {registerWebMcp} from '../dist/typescript/webmcp.js';
import {itemActions} from '../dist/mcp/item-actions.js';

const schemas=new Map(tools.map(tool=>[tool.name,new Ajv({strict:false}).compile(tool.inputSchema)]));
test('exactly eleven deliberate families; readonly schemas retain only discovery variants',()=>{
  assert.deepEqual(tools.map(t=>t.name).sort(),['session','observe','interact','lookup','plan','travel','use','inventory','equipment','respond','help'].sort());
  const read=new Map(readOnlyTools.map(tool=>[tool.name,new Ajv({strict:false}).compile(tool.inputSchema)]));
  for(const name of ['use','interact']){
    assert.ok(read.get(name)({sessionId:'test'}));
    assert.equal(read.get(name)({sessionId:'test',viewId:'view',action:name==='use'?'read':'pray'}),false);
  }
  assert.equal(read.has('travel'),false);
  for(const [name,args] of [['use',{action:'cast',itemId:'item'}],['travel',{mode:'step',to:{x:1,y:1}}],['interact',{action:'open',turns:10}],['respond',{action:'cancel',value:false}]])
    assert.equal(schemas.get(name)({sessionId:'test',viewId:'view',decisionId:'question',...args}),false);
});

for(const mode of ['native','wasm'])test(`${mode}: discovery never inputs; offers are explicit, view-bound and decision-safe`,async t=>{
  const transport=mode==='native'?(await fixture(t)).transport:await WasmTransport.create();
  if(mode==='wasm')t.after(()=>transport.close());
  const inputs=[];let last;
  const agent=new AgentClient({send:async request=>{
    if(request.method.startsWith('game.')||request.method.startsWith('decision.'))inputs.push(request);
    const response=await transport.send(request);
    if('observation' in response)last=response;
    return response;
  }});
  const created=await agent.call('session',{action:'create',...identity});
  assert.equal(created.error,undefined);
  const sid={sessionId:created.basis.sessionId};
  const all=await agent.call('use',sid);
  assert.equal(all.outcome.actionsTaken,0);assert.equal(all.basis.turn,created.basis.turn);
  assert.ok(all.result.items.length);
  for(const item of all.result.items)for(const offer of item.attempts??[]){
    assert.ok(schemas.get(offer.tool)(offer.arguments),JSON.stringify(offer));
    assert.equal(offer.arguments.viewId,all.basis.viewId);
  }
  const item=all.result.items.find(item=>item.attempts.length);
  const one=await agent.call('use',{...sid,itemId:item.itemId});
  assert.equal(one.result.items.length,1);
  const square=await agent.call('interact',sid);
  assert.equal(square.error,undefined);assert.equal(square.outcome.actionsTaken,0);
  for(const offer of square.result.attempts)assert.ok(schemas.get(offer.tool)(offer.arguments),JSON.stringify(offer));
  const ambiguous=await agent.call('interact',{...sid,target:{symbol:'.',scope:'level'}});
  assert.equal(ambiguous.error.code,'ambiguousTarget');assert.ok(ambiguous.error.candidates.length>1);
  for(const name of ['create','step','zap','cast','inspect','answer'])assert.equal((await agent.call(name,sid)).error.code,'unknownTool');
  assert.equal(inputs.length,0);
  // One candidate remains discovery; missing/stale perception never invents offers.
  const controlled=structuredClone(last),selected=controlled.observation.inventory.find(i=>i.id===item.itemId);
  controlled.sessionId='isolated-discovery-fixture-'+mode;
  selected.actions=['drop'];
  const single=itemActions(controlled,item.itemId);
  assert.equal(single.items[0].attempts.length,1);assert.equal(inputs.length,0);
  controlled.observation.perception.inventory='lastKnown';
  assert.equal(itemActions(controlled,item.itemId).items[0].attempts,undefined);
  const prayer=await agent.call('interact',{...sid,viewId:square.basis.viewId,action:'pray'});
  assert.equal(prayer.decision.kind,'confirmation');assert.equal(inputs.length,1);
  const whilePending=await agent.call('use',{...sid,itemId:item.itemId});
  assert.equal(whilePending.decision.id,prayer.decision.id);assert.equal(inputs.length,1);
  const stale=await agent.call('inventory',{...sid,viewId:all.basis.viewId,action:'drop',itemId:item.itemId});
  assert.equal(stale.error.code,'staleView');assert.equal(inputs.length,1);
  const reply=whilePending.decision.reply;
  assert.equal(reply.tool,'respond');assert.equal(reply.arguments.action,'answer');
  const declined=await agent.call(reply.tool,{...reply.arguments,value:false});
  assert.equal(declined.decision,null);assert.equal(inputs.length,2);
  const travel=await agent.call('travel',{...sid,viewId:declined.basis.viewId,mode:'explore',maxPlanningMs:0});
  assert.equal(travel.result.reason,'planningLimit');assert.equal(inputs.length,2);
});

test('readonly WebMCP registration rejects mutating variants before touching transport',async t=>{
  let sends=0;const registered=new Map();
  const registration=await registerWebMcp({send:async()=>{sends++;throw Error('must not dispatch');}},
    {registerTool:tool=>{registered.set(tool.name,tool);}},{tools:readOnlyTools});
  t.after(()=>registration.dispose());
  const rejected=await registered.get('use').execute({sessionId:'test',viewId:'view',action:'read'});
  assert.equal(rejected.structuredContent.error.code,'invalidParams');assert.equal(sends,0);
});
