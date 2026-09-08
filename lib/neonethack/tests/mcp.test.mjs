import { test } from 'node:test';
import assert from 'node:assert/strict';
const perceivedFrame=({neighborhood,...frame})=>frame;
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { tools as expectedTools, instructions } from '../dist/mcp/agent-data.js';
import Ajv from 'ajv/dist/2020.js';
import { root, identity } from './native-fixture.mjs';
const validateResponse=new Ajv({strict:false}).compile(JSON.parse(await readFile(new URL('../protocol/response.schema.json',import.meta.url),'utf8')));

test('C official MCP SDK stdio roundtrip exposes strict tools and structured results', { timeout: 30_000 }, async t => {
  const sessions = await mkdtemp(`${tmpdir()}/neonethack-mcp-`);
  const client = new Client({ name: 'contract-test', version: '1' });
  const transport = new StdioClientTransport({
    command: `${root}/build/native/neonethack-mcp`,
    args: [ `${root}/engine/playground/nethack`, `${root}/engine/playground`, sessions],
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
  const invoke = async (name, args) => {
    const result = await client.callTool({ name: `${name}`, arguments: args });
    assert.deepEqual(result.content, []);
    const {summary,creatures,operationId,historical,navigation,presentation,...low}=result.structuredContent;
    if(low.observation)low.requestId=operationId??null;
    assert.equal(typeof summary,'string');if(!presentation)assert.ok(validateResponse(low),JSON.stringify(validateResponse.errors));else {assert.equal(presentation.kind,'compact');assert.ok(low.observation.world);assert.equal(low.observation.neighborhood,undefined);}
    return result;
  };
  const created = await invoke('session_create', identity);
  assert.equal(created.isError, false);
  const state = created.structuredContent;
  assert.ok(state.observation.world.length);
  assert.equal(state.observation.neighborhood,undefined);assert.equal(state.presentation.kind,'compact');
  await assert.rejects(client.callTool({name:'game_wait',arguments:{sessionId:state.sessionId,requestId:'caller-guard'}}),/invalid arguments/i);
  const prayerArgs = { sessionId: state.sessionId };
  const prayer = (await invoke('game_pray', prayerArgs)).structuredContent;
  assert.equal(prayer.decision.kind, 'confirmation');
  assert.deepEqual(perceivedFrame((await invoke('receipt', {...prayerArgs,operationId:prayer.operationId})).structuredContent.observation),perceivedFrame(prayer.observation));
  const declined = await invoke('decision_answer', { sessionId: state.sessionId, answer: { kind: 'confirmation', confirm: false } });
  assert.equal(declined.isError, false);
  assert.equal(declined.structuredContent.decision, null);
  await invoke('session_close', { sessionId: state.sessionId });
  const random = await client.callTool({name:'session_create'});
  assert.equal(random.isError,false);
  assert.equal(random.structuredContent.decision,null);
  assert.match(random.structuredContent.observation.vitals.title,/^[A-Z][a-z]+ [A-Z][a-z]+ the /);
  await invoke('session_close',{sessionId:random.structuredContent.sessionId});
});

test('C stdio MCP runs concurrent games with unchanged tools and isolated decisions', { timeout: 60000 }, async t => {
  const sessions = await mkdtemp(`${tmpdir()}/neonethack-mcp-multi-`);
  const client = new Client({ name: 'multi-game-test', version: '1' });
  const transport = new StdioClientTransport({ command: `${root}/build/native/neonethack-mcp`,
    args: [ `${root}/engine/playground/nethack`, `${root}/engine/playground`, sessions],
    env: { NEONETHACK_EXECUTABLE: `${root}/build/native/neonethack` }, stderr: 'pipe' });
  t.after(async () => { await client.close(); await rm(sessions, { recursive: true, force: true }); });
  await client.connect(transport);
  assert.deepEqual((await client.listTools()).tools, expectedTools);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, false, JSON.stringify(result));
    return result.structuredContent;
  };
  const [a, b] = await Promise.all([call('session_create', identity), call('session_create', { ...identity, name: 'Second' })]);
  assert.notEqual(a.sessionId, b.sessionId);
  const prayer = await call('game_pray', { sessionId: a.sessionId });
  assert.equal(prayer.decision.kind, 'confirmation');
  assert.equal((await call('session_observe', { sessionId: b.sessionId })).decision, null);
  await call('session_close', { sessionId: b.sessionId });
  assert.deepEqual((await call('session_observe', { sessionId: a.sessionId })).decision, prayer.decision);
  assert.equal((await call('session_resume', { sessionId: b.sessionId })).decision, null);
  await Promise.all([a, b].map(state => call('session_close', { sessionId: state.sessionId })));
});

test('C stdio MCP framing, notifications and complete navigation observations', {timeout: 30000}, async t => {
  const {spawn} = await import('node:child_process');
  const {createInterface} = await import('node:readline');
  const sessions = await mkdtemp(`${tmpdir()}/neonethack-mcp-wire-`);
  const child = spawn(`${root}/build/native/neonethack-mcp`, [`${root}/engine/playground/nethack`, `${root}/engine/playground`, sessions]);
  t.after(async () => { child.kill(); await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit',resolve)); await rm(sessions,{recursive:true,force:true}); });
  const lines = createInterface({input:child.stdout})[Symbol.asyncIterator]();
  const send = async value => { child.stdin.write(typeof value === 'string' ? value : JSON.stringify({jsonrpc:'2.0',...value})+'\n'); return JSON.parse((await lines.next()).value); };
  assert.equal((await send('{\n')).error.code,-32700);
  assert.equal((await send({id:1,method:'tools/list'})).error.code,-32000);
  assert.equal((await send({id:'init',method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}})).id,'init');
  // Notification must never start a game or consume an action; ping is next reply.
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'tools/call',params:{name:'session_create',arguments:identity}})+'\n');
  assert.equal((await send({id:2,method:'ping'})).id,2);
  assert.equal((await send({id:3,method:'unknown'})).error.code,-32601);
  assert.equal((await send({id:4,method:'tools/call',params:{name:'act'}})).error.code,-32602);
  assert.equal((await send('x'.repeat(13000)+'\n')).error.code,-32700);
  assert.equal((await send({id:5,method:'ping'})).id,5,'oversized line is drained');
  assert.equal((await send('{"jsonrpc":"2.0","id":6,"method":"ping","method":"tools/call"}\n')).error.code,-32600);
  assert.equal((await send('{"jsonrpc":"2.0","id":7,"meth\\u006fd":"ping"}\n')).id,7);
  let id = 10;
  const call = async (method,args) => (await send({id:id++,method:'tools/call',params:{name:method,arguments:args}})).result.structuredContent;
  let state=await call('session_create',identity);
  for(let i=0;i<8;i++){
    const to={x:state.observation.you.x+(i%2?-1:1),y:state.observation.you.y};
    state=await call('go',{sessionId:state.sessionId,to,force:true});
    assert.equal(state.update,undefined);assert.ok(state.observation);
    assert.ok(state.navigation.actionsTaken<=1);
  }
  const observed=await call('session_observe',{sessionId:state.sessionId});
  assert.equal(observed.update,undefined);assert.ok(observed.observation.neighborhood);
  const {neighborhood,...fullPerception}=observed.observation;
  assert.deepEqual(fullPerception,state.observation,'compact agent observations remain self-contained; explicit observe adds attempts');
  assert.equal(state.presentation.kind,'compact');

});
