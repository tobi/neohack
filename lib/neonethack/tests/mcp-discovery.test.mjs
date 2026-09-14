import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {root} from './native-fixture.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {exerciseAgentSyntax} from './agent-syntax-contracts.mjs';
import {agentMethods, agentOmitted,agentTools} from '../protocol/agent.ts';
import {operationCoverage} from '../scripts/check-tools.mjs';
import {catalog} from '../protocol/catalog.ts';
import {mcpResponseSchema} from '../protocol/response.ts';

test('discovery maps low operations, requires observed views and publishes v2 output schemas',()=>{
  assert.deepEqual(operationCoverage(catalog.methods,agentMethods,agentOmitted),[]);
  assert.deepEqual(operationCoverage(catalog.methods,agentMethods),['uncovered operation: game.moveWithoutAttack'],'the omission is deliberate and documented, not a gap');
  assert.ok(!agentTools.some(t=>t.name==='moveWithoutAttack'));
  assert.equal(new Set(agentTools.map(t=>t.name)).size,agentTools.length);
  assert.ok(agentTools.every(t=>!t.name.includes('_')));
  for(const t of agentTools){
    assert.equal(t.inputSchema.properties.requestId,undefined);assert.equal(t.inputSchema.properties.expectedRevision,undefined);
    assert.equal(t.inputSchema.properties.item,undefined);
    assert.deepEqual(t.outputSchema,mcpResponseSchema,t.name);
  }
  for(const variant of agentMethods){
    const schema=variant.schema;
    const guarded=!variant.readOnly&&!['session.create','session.resume','session.close','decision.answer','decision.cancel'].includes(variant.method);
    assert.equal(schema.required.includes('viewId'),guarded,variant.method);
    if(variant.method.startsWith('decision.'))assert.ok(schema.required.includes('decisionId'));
    if(variant.method==='decision.answer')assert.ok(schema.required.includes('value'));
    if(['agent.go','agent.explore','agent.descend'].includes(variant.method)){
      assert.equal(schema.properties.maxPlanningMs.minimum,0);assert.equal(schema.properties.maxPlanningMs.default,1000);
      assert.equal(schema.properties.timeoutMs,undefined);
    }
    if(schema.properties.quantity)assert.deepEqual(schema.dependentRequired,{quantity:['itemId']});
  }
  assert.equal(agentTools.length,11);
  assert.ok(agentTools.some(t=>t.name==='travel'));
  const go=agentMethods.find(m=>m.method==='agent.go');assert.equal(go.schema.properties.direction,undefined);assert.ok(go.schema.required.includes('to'));
});
test('Bun/WASM stdio discovery syntax handles all six genuine question kinds and partial stacks',{timeout:30000},async t=>{
  const sessions=await mkdtemp(tmpdir()+'/nnh-syntax-');
  const client=new Client({name:'syntax-contract',version:'1'});
  t.after(async()=>{await client.close();await rm(sessions,{recursive:true,force:true});});
  await client.connect(new StdioClientTransport({command:root+'/dist/mcp/cli.js',args:['--sessions',sessions],stderr:'pipe'}));
  assert.deepEqual((await client.listTools()).tools,agentTools);
  await exerciseAgentSyntax(async(name,args)=>{
    try{return (await client.callTool({name,arguments:args})).structuredContent;}
    catch(error){throw new Error(`Syntax scenario failed calling ${name}`,{cause:error});}
  });
});
