import assert from 'node:assert/strict';
import {withSessionViews} from './mcp-view-fixture.mjs';
import Ajv from 'ajv/dist/2020.js';
import {tools} from '../dist/mcp/agent-data.js';
import {mcpResponseSchema} from '../dist/mcp/protocol-data.js';
const ajv=new Ajv({strict:false});
const validateResponse=ajv.compile(mcpResponseSchema);

/** Real engine scenarios shared by C stdio and TS native/WASM adapters. */
export async function exerciseAgentSyntax(rawCall) {
  const call=withSessionViews(rawCall);
  const invoke=async(name,args={})=>{const r=await call(name,args);assert.ok(!r.error,JSON.stringify({name,error:r.error}));assert.ok(validateResponse(r),JSON.stringify({name,errors:validateResponse.errors}));return r;};
  const reply=async(question,value)=>{
    assert.equal(question.decision.reply.tool,'respond');
    assert.deepEqual(question.decision.reply.arguments,{sessionId:question.basis.sessionId,decisionId:question.decision.id,action:'answer'});
    assert.ok(ajv.compile(question.decision.reply.valueSchema)(value));
    return invoke(question.decision.reply.tool,{...question.decision.reply.arguments,value});
  };
  let state=await invoke("session", {action: "create", name:'Syntax',role:'wizard',race:'human',gender:'male',align:'neutral',seed:7});
  const sid={sessionId:state.basis.sessionId};
  const inspection=await invoke("interact", {...sid,target:{direction:'self'}});
  assert.ok(inspection.result.attempts.length);
  assert.equal(inspection.scene.nearby.cells.find(c=>c.direction==='self').mark,state.scene.map.text.split('\n')[2+state.scene.self.position.y-state.scene.map.bounds.y[0]][4+state.scene.self.position.x-state.scene.map.bounds.x[0]]);
  for(const attempt of inspection.result.attempts){const tool=tools.find(t=>t.name===attempt.tool);assert.ok(tool);assert.ok(ajv.compile(tool.inputSchema)(attempt.arguments));}
  assert.equal((await invoke("observe", sid)).basis.revision,state.basis.revision);
  const read=await invoke("use", {action: "read", ...(sid)}),scroll=read.decision.options.find(i=>i.label.includes('scroll of food detection'));
  assert.ok(scroll);
  const wrong=await call("respond", {action: "answer", ...read.decision.reply.arguments,value:true});
  assert.equal(wrong.error?.code,'invalidParams');assert.equal(wrong.outcome.operationId,undefined);
  assert.deepEqual((await invoke("observe", sid)).decision,read.decision);
  state=await reply(read,{itemId:scroll.id});assert.equal(state.decision.kind,'position');
  state=await reply(state,'west');assert.equal(state.decision.kind,'position');
  state=await reply(state,state.decision.cursor); // Exact perceived cursor coordinate.
  if(state.decision)state=await reply(state,'finish');
  assert.equal(state.decision,null);
  const prayer=await invoke("interact", {action: "pray", ...(sid)});assert.equal(prayer.decision.kind,'confirmation');
  await reply(prayer,false);
  await invoke("session", {action: "suspend", ...(sid)});

  state=await invoke("session", {action: "create", name:'SyntaxMage',role:'wizard',race:'human',gender:'female',align:'neutral',seed:42});
  const mage={sessionId:state.basis.sessionId};
  const pen=await invoke("use", {action: "engrave", ...(mage)});assert.equal(pen.decision.kind,'item');
  const hands=pen.decision.options.find(i=>i.id==='hands');assert.ok(hands);
  const text=await reply(pen,{itemId:hands.id});assert.equal(text.decision.kind,'text');
  state=await reply(text,'Hello dungeon');assert.equal(state.decision,null);
  const spell=await invoke("use", {action: "cast", ...(mage)});assert.equal(spell.decision.kind,'choice');
  const bolt=spell.decision.options.find(o=>o.label.includes('force bolt'));assert.ok(bolt,JSON.stringify(spell.decision.options));
  const target=await reply(spell,[bolt.name]);assert.equal(target.decision.kind,'target');
  state=await reply(target,'north');assert.equal(state.decision,null);
  const receipt=await invoke("observe", {...mage,operationId:state.outcome.operationId});assert.equal(receipt.result.operationId,state.outcome.operationId);
  await invoke("session", {action: "suspend", ...(mage)});

  state=await invoke("session", {action: "create", name:'SyntaxStack',role:'archeologist',seed:13});
  const bag={sessionId:state.basis.sessionId},food=state.scene.inventory.find(i=>i.known.identity==='food ration');assert.ok(food.quantity>1);
  for(const args of [{item:{id:food.id}},{item:food.id},{quantity:1}]){
    let rejected;
    try{rejected=await call("inventory", {action: "drop", ...bag,...args});}
    catch(error){assert.equal(error.code,-32602,'native MCP schema rejection');continue;}
    assert.equal(rejected.error?.code,'invalidParams');assert.equal(rejected.outcome.operationId,undefined);
  }
  const afterInvalid=await invoke("observe", bag);assert.equal(afterInvalid.basis.revision,state.basis.revision);
  state=await invoke("inventory", {action: "drop", ...bag,itemId:food.id,quantity:1});
  assert.equal(state.scene.inventory.find(i=>i.id===food.id).quantity,food.quantity-1);
  assert.equal((await invoke("observe", bag)).basis.revision,state.basis.revision);
  await invoke("session", {action: "suspend", ...(bag)});
}
