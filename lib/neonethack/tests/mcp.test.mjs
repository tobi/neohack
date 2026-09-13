import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { tools as expectedTools, instructions } from '../dist/mcp/agent-data.js';
import Ajv from 'ajv/dist/2020.js';
import {withSessionViews, assertSceneObservation} from './mcp-view-fixture.mjs';
import { root, identity } from './native-fixture.mjs';
const validateResponse=new Ajv({strict:false}).compile(JSON.parse(await readFile(new URL('../protocol/mcp-response.schema.json',import.meta.url),'utf8')));

test('Bun/WASM official MCP SDK stdio roundtrip exposes strict tools and structured results', { timeout: 30_000 }, async t => {
  const sessions = await mkdtemp(`${tmpdir()}/neonethack-mcp-`);
  const client = new Client({ name: 'contract-test', version: '1' });
  const transport = new StdioClientTransport({
    command: `${root}/dist/mcp/cli.js`,
    args: ['--sessions',sessions],
    env: { NEONETHACK_EXECUTABLE: `${root}/build/native/neonethack` },
    stderr: 'pipe',
  });
  t.after(async () => { await client.close(); await rm(sessions, { recursive: true, force: true }); });
  transport.stderr?.on("data", data => t.diagnostic(String(data)));
  await client.connect(transport);
  assert.equal(client.getInstructions(), instructions);
  const { tools } = await client.listTools();
  assert.ok(tools.some(tool => tool.name === 'go'));
  assert.ok(tools.every(tool => !tool.name.startsWith('neonethack_')));
  assert.ok(!tools.some(tool => tool.name === 'act'));
  assert.ok(tools.every(tool => tool.inputSchema.additionalProperties === false));
  assert.deepEqual(tools, expectedTools);
  const callFrame=withSessionViews(async(name,args)=>{
    const result=await client.callTool({name,arguments:args});
    assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent);
    assert.ok(validateResponse(result.structuredContent),JSON.stringify(validateResponse.errors));
    return result.structuredContent;
  });
  const invoke=async(name,args)=>{
    const frame=await callFrame(name,args);
    assert.equal(frame.error,undefined,JSON.stringify(frame.error));
    return frame;
  };
  const created = await invoke("create", identity);
  const state = created;
  assert.equal(state.scene.world,undefined,'ordinary replies use the perceived map');assert.ok(state.scene.map.text.includes('@'));
  assert.equal(state.scene.kind,'snapshot');assert.equal(state.control.gate,'ready');
  assert.equal((await client.callTool({name:'wait',arguments:{sessionId:state.basis.sessionId,requestId:'caller-guard'}})).structuredContent.error.code,'invalidParams');
  const prayerArgs = { sessionId: state.basis.sessionId };
  const prayer = await invoke("pray", prayerArgs);
  assert.equal(prayer.decision.kind, 'confirmation');
  const historical=await invoke('receipt',{...prayerArgs,operationId:prayer.outcome.operationId});
  assertSceneObservation(prayer,historical.result.receipt.observation);
  assert.deepEqual(historical.scene,prayer.scene);assert.deepEqual(historical.decision,prayer.decision);
  const declined = await invoke("answer", { sessionId: state.basis.sessionId, decisionId: prayer.decision.id, value: false });
  assert.equal(declined.decision,null);
  const oldReceipt=await invoke('receipt',{...prayerArgs,operationId:prayer.outcome.operationId});
  assert.equal(oldReceipt.decision,null,'historical questions do not become current decisions');
  assert.equal(oldReceipt.result.receipt.decision.id,prayer.decision.id);
  assert.equal(oldReceipt.basis.revision,declined.basis.revision);
  await invoke("suspend", { sessionId: state.basis.sessionId });
  const random=await invoke("create");
  assert.equal(random.decision,null);
  assert.match(random.scene.self.vitals.title,/^[A-Z][a-z]+ [A-Z][a-z]+ the /);
  await invoke("suspend",{sessionId:random.basis.sessionId});
});

test('Bun/WASM stdio MCP runs concurrent games with unchanged tools and isolated decisions', { timeout: 60000 }, async t => {
  const sessions = await mkdtemp(`${tmpdir()}/neonethack-mcp-multi-`);
  const client = new Client({ name: 'multi-game-test', version: '1' });
  const transport = new StdioClientTransport({ command: `${root}/dist/mcp/cli.js`,
    args: ['--sessions',sessions],
    env: { NEONETHACK_EXECUTABLE: `${root}/build/native/neonethack` }, stderr: 'pipe' });
  t.after(async () => { await client.close(); await rm(sessions, { recursive: true, force: true }); });
  await client.connect(transport);
  assert.deepEqual((await client.listTools()).tools, expectedTools);
  const call = withSessionViews(async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.ok(validateResponse(result.structuredContent),JSON.stringify(validateResponse.errors));
    return result.structuredContent;
  });
  const [a, b] = await Promise.all([call("create", identity), call("create", { ...identity, name: 'Second' })]);
  assert.notEqual(a.basis.sessionId, b.basis.sessionId);
  const prayer = await call("pray", { sessionId: a.basis.sessionId });
  assert.equal(prayer.decision.kind, 'confirmation');
  assert.equal((await call("syncState", { sessionId: b.basis.sessionId })).decision, null);
  await call("suspend", { sessionId: b.basis.sessionId });
  assert.deepEqual((await call("syncState", { sessionId: a.basis.sessionId })).decision, prayer.decision);
  assert.equal((await call("resume", { sessionId: b.basis.sessionId })).decision, null);
  await Promise.all([a, b].map(state => call("suspend", { sessionId: state.basis.sessionId })));
});

test('Bun/WASM stdio MCP framing, notifications and complete navigation observations', {timeout: 30000}, async t => {
  const {spawn} = await import('node:child_process');
  const {createInterface} = await import('node:readline');
  const sessions = await mkdtemp(`${tmpdir()}/neonethack-mcp-wire-`);
  const child = spawn(`${root}/dist/mcp/cli.js`, ['--sessions',sessions]);
  t.after(async () => { child.kill(); await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit',resolve)); await rm(sessions,{recursive:true,force:true}); });
  const lines = createInterface({input:child.stdout})[Symbol.asyncIterator]();
  const send = async value => { child.stdin.write(typeof value === 'string' ? value : JSON.stringify({jsonrpc:'2.0',...value})+'\n'); return JSON.parse((await lines.next()).value); };
  assert.equal((await send('{\n')).error.code,-32700);
  assert.equal((await send({id:1,method:'tools/list'})).error.code,-32000);
  assert.equal((await send({id:'init',method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}})).id,'init');
  // Notification must never start a game or consume an action; ping is next reply.
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'tools/call',params:{name:"create",arguments:identity}})+'\n');
  assert.equal((await send({id:2,method:'ping'})).id,2);
  assert.equal((await send({id:3,method:'unknown'})).error.code,-32601);
  assert.equal((await send({id:4,method:'tools/call',params:{name:'act'}})).error.code,-32602);
  assert.equal((await send('x'.repeat(65537)+'\n')).error.code,-32700);
  assert.equal((await send({id:5,method:'ping'})).id,5,'oversized line is drained');
  assert.equal((await send('{"jsonrpc":"2.0","id":6,"method":"ping","method":"tools/call"}\n')).error.code,-32600);
  assert.equal((await send('{"jsonrpc":"2.0","id":7,"meth\\u006fd":"ping"}\n')).id,7);
  let id = 10;
  const call=withSessionViews(async(method,args)=>{
    const frame=(await send({id:id++,method:'tools/call',params:{name:method,arguments:args}})).result.structuredContent;
    assert.ok(validateResponse(frame),JSON.stringify(validateResponse.errors));
    return frame;
  });
  let state=await call('create',identity);
  for(let i=0;i<8;i++){
    state=await call('step',{sessionId:state.basis.sessionId,target:{direction:i%2?'west':'east'}});
    assert.equal(state.scene.kind,'snapshot');assert.ok(state.scene.self);
    assert.ok(state.outcome.actionsTaken<=1);
  }
  const observed=await call('syncState',{sessionId:state.basis.sessionId});
  assert.equal(observed.scene.kind,'snapshot');assert.ok(observed.scene.world.length);
  for(const key of ['self','nearby','entities','features','map','inventory','inventoryKnown','here','perception','end'])
    assert.deepEqual(observed.scene[key],state.scene[key],key);
  assert.equal(observed.basis.turn,state.basis.turn);
  assert.equal(observed.basis.revision,state.basis.revision);
  assert.ok(observed.scene.knowledge);
});
