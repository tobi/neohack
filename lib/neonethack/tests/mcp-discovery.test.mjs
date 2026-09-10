import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {root} from './native-fixture.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {exerciseAgentSyntax} from './agent-syntax-contracts.mjs';
import {agentMethods,agentTools} from '../protocol/agent.ts';
import {operationCoverage} from '../scripts/check-tools.mjs';
import {catalog} from '../protocol/catalog.ts';

test('discovery names every operation, strips caller guards and uses explicit item IDs',()=>{
  assert.deepEqual(operationCoverage(catalog.methods,agentMethods),[]);
  assert.equal(new Set(agentTools.map(t=>t.name)).size,agentTools.length);
  assert.ok(agentTools.every(t=>!t.name.includes('_')));
  for(const t of agentTools){
    assert.equal(t.inputSchema.properties.requestId,undefined);assert.equal(t.inputSchema.properties.expectedRevision,undefined);
    assert.equal(t.inputSchema.properties.item,undefined);
  }
  const answer=agentTools.find(t=>t.name==='answer');assert.ok(answer.inputSchema.required.includes('value'));
  assert.ok(answer.inputSchema.required.includes('decisionId'));assert.equal(answer.inputSchema.properties.answer,undefined);
  assert.ok(JSON.stringify(agentTools).length<40000,'bounded catalog size; do not duplicate low item/tagged-answer schemas');
});
test('Bun/WASM stdio discovery syntax handles all six genuine question kinds and partial stacks',{timeout:30000},async t=>{
  const sessions=await mkdtemp(tmpdir()+'/nnh-syntax-');
  const client=new Client({name:'syntax-contract',version:'1'});
  t.after(async()=>{await client.close();await rm(sessions,{recursive:true,force:true});});
  await client.connect(new StdioClientTransport({command:root+'/dist/mcp/cli.js',args:['--sessions',sessions],stderr:'pipe'}));
  assert.deepEqual((await client.listTools()).tools,agentTools);
  await exerciseAgentSyntax(async(name,args)=>(await client.callTool({name,arguments:args})).structuredContent);
});
