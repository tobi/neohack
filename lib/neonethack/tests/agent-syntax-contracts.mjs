import assert from 'node:assert/strict';
import Ajv from 'ajv/dist/2020.js';
import {tools} from '../dist/mcp/agent-data.js';
import {compactResponseSchema} from '../dist/mcp/protocol-data.js';
const ajv=new Ajv({strict:false});
const validateResponse=ajv.compile(compactResponseSchema);

/** Real engine scenarios shared by C stdio and TS native/WASM adapters. */
export async function exerciseAgentSyntax(call) {
  const invoke=async(name,args={})=>{const r=await call(name,args);assert.ok(!r.error,JSON.stringify({name,error:r.error}));assert.ok(validateResponse(r),JSON.stringify({name,errors:validateResponse.errors}));return r;};
  const reply=async(question,value)=>{
    assert.equal(question.reply.tool,'answer');
    assert.deepEqual(question.reply.arguments,{sessionId:question.sessionId,decisionId:question.decision.id});
    assert.ok(ajv.compile(question.reply.valueSchema)(value));
    return invoke(question.reply.tool,{...question.reply.arguments,value});
  };
  let state=await invoke('create',{name:'Syntax',role:'wizard',race:'human',gender:'male',align:'neutral',seed:7});
  const sid={sessionId:state.sessionId};
  const inspection=await invoke('inspect',{...sid,target:'here'});
  assert.ok(inspection.attempts.length);
  assert.equal(inspection.mark,state.map.text.split('\n')[2+state.observation.you.y-state.map.bounds.y[0]][4+state.observation.you.x-state.map.bounds.x[0]]);
  for(const attempt of inspection.attempts){const tool=tools.find(t=>t.name===attempt.tool);assert.ok(tool);assert.ok(ajv.compile(tool.inputSchema)(attempt.arguments));}
  assert.equal((await invoke('syncState',sid)).revision,state.revision);
  const read=await invoke('read',sid),scroll=read.decision.options.find(i=>i.label.includes('scroll of food detection'));
  assert.ok(scroll);
  const wrong=await call('answer',{...read.reply.arguments,value:true});
  assert.equal(wrong.error?.code,'invalidParams');assert.equal(wrong.operationId,undefined);
  assert.deepEqual((await invoke('syncState',sid)).decision,read.decision);
  state=await reply(read,{itemId:scroll.id});assert.equal(state.decision.kind,'position');
  state=await reply(state,'west');assert.equal(state.decision.kind,'position');
  state=await reply(state,state.decision.cursor); // Exact perceived cursor coordinate.
  if(state.decision)state=await reply(state,'finish');
  assert.equal(state.decision,null);
  const prayer=await invoke('pray',sid);assert.equal(prayer.decision.kind,'confirmation');
  await reply(prayer,false);
  await invoke('suspend',sid);

  state=await invoke('create',{name:'SyntaxMage',role:'wizard',race:'human',gender:'female',align:'neutral',seed:42});
  const mage={sessionId:state.sessionId};
  const pen=await invoke('engrave',mage);assert.equal(pen.decision.kind,'item');
  const hands=pen.decision.options.find(i=>i.id==='hands');assert.ok(hands);
  const text=await reply(pen,{itemId:hands.id});assert.equal(text.decision.kind,'text');
  state=await reply(text,'Hello dungeon');assert.equal(state.decision,null);
  const spell=await invoke('cast',mage);assert.equal(spell.decision.kind,'choice');
  const bolt=spell.decision.options.find(o=>o.label.includes('force bolt'));assert.ok(bolt,JSON.stringify(spell.decision.options));
  const target=await reply(spell,[bolt.name]);assert.equal(target.decision.kind,'target');
  state=await reply(target,'north');assert.equal(state.decision,null);
  const receipt=await invoke('receipt',{...mage,operationId:state.operationId});assert.equal(receipt.operationId,state.operationId);
  await invoke('suspend',mage);

  state=await invoke('create',{name:'SyntaxStack',role:'archeologist',seed:13});
  const bag={sessionId:state.sessionId},food=state.observation.inventory.find(i=>i.known.identity==='food ration');assert.ok(food.quantity>1);
  for(const args of [{item:{id:food.id}},{item:food.id},{quantity:1}]){
    let rejected;
    try{rejected=await call('drop',{...bag,...args});}
    catch(error){assert.equal(error.code,-32602,'native MCP schema rejection');continue;}
    assert.equal(rejected.error?.code,'invalidParams');assert.equal(rejected.operationId,undefined);
  }
  const afterInvalid=await invoke('syncState',bag);assert.equal(afterInvalid.revision,state.revision);
  state=await invoke('drop',{...bag,itemId:food.id,quantity:1});
  assert.equal(state.observation.inventory.find(i=>i.id===food.id).quantity,food.quantity-1);
  assert.equal((await invoke('syncState',bag)).revision,state.revision);
  await invoke('suspend',bag);
}
