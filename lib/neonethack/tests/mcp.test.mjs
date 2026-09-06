import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CompactObservationReader } from '../dist/mcp/compact.js';
import { tools as expectedTools } from '../dist/mcp/tools.js';
import { root, identity } from './native-fixture.mjs';

for (const native of [false, true]) test(`${native ? 'C' : 'Node'} official MCP SDK stdio roundtrip exposes strict tools and structured results`, { timeout: 30_000 }, async t => {
  const sessions = await mkdtemp(`${tmpdir()}/neonethack-mcp-`);
  const client = new Client({ name: 'contract-test', version: '1' });
  const transport = new StdioClientTransport({
    command: native ? `${root}/build/native/neonethack-mcp` : process.execPath,
    args: [...(native ? [] : [`${root}/dist/mcp/cli.js`]), `${root}/engine/playground/nethack`, `${root}/engine/playground`, sessions],
    env: { NEONETHACK_EXECUTABLE: `${root}/build/native/neonethack` },
    stderr: 'pipe',
  });
  t.after(async () => { await client.close(); await rm(sessions, { recursive: true, force: true }); });
  transport.stderr?.on("data", data => t.diagnostic(String(data)));
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.ok(tools.some(tool => tool.name === 'game_move'));
  assert.ok(tools.every(tool => !tool.name.startsWith('neonethack_')));
  assert.ok(!tools.some(tool => tool.name === 'act'));
  assert.ok(tools.every(tool => tool.inputSchema.additionalProperties === false && tool.outputSchema));
  assert.deepEqual(tools, expectedTools);
  const reader = new CompactObservationReader();
  const invoke = async (name, args) => {
    const result = await client.callTool({ name: `${name}`, arguments: args });
    assert.deepEqual(result.content, []);
    result.structuredContent = reader.apply(result.structuredContent);
    return result;
  };
  const created = await invoke('session_create', identity);
  assert.equal(created.isError, false);
  const state = created.structuredContent;
  assert.ok(state.observation.world.length);
  assert.equal(state.observation.neighborhood, undefined);
  const bad = await invoke('game_wait', { sessionId: state.sessionId, requestId: 'typo', expectedRevision: state.revision, direction: 'south' });
  assert.equal(bad.isError, true);
  assert.equal(bad.structuredContent.error.code, 'invalidParams');
  const prayerArgs = { sessionId: state.sessionId, requestId: 'prayer', expectedRevision: state.revision };
  const prayer = (await invoke('game_pray', prayerArgs)).structuredContent;
  assert.equal(prayer.decision.kind, 'confirmation');
  assert.deepEqual((await invoke('game_pray', prayerArgs)).structuredContent, prayer);
  const declined = await invoke('decision_answer', { sessionId: state.sessionId, requestId: 'decline', expectedRevision: prayer.revision, decisionId: prayer.decision.id, answer: { kind: 'confirmation', confirm: false } });
  assert.equal(declined.isError, false);
  assert.equal(declined.structuredContent.decision, null);
  await invoke('session_close', { sessionId: state.sessionId });
  const random = await client.callTool({name:'session_create'});
  assert.equal(random.isError,false);
  assert.equal(random.structuredContent.decision,null);
  assert.match(random.structuredContent.observation.vitals.title,/^[A-Z][a-z]+ [A-Z][a-z]+ the /);
  reader.apply(random.structuredContent);
  await invoke('session_close',{sessionId:random.structuredContent.sessionId});
});

test('C stdio MCP framing, notifications and exact movement deltas', {timeout: 30000}, async t => {
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
  const reader = new CompactObservationReader();
  let state = reader.apply(await call('session_create',identity));
  let delta;
  for(let i=0;i<8;i++) {
    delta = await call('game_move',{sessionId:state.sessionId,requestId:'wire-'+i,expectedRevision:state.revision,direction:i%2?'west':'east'});
    assert.equal(delta.update.kind,'delta');
    state = reader.apply(delta);
  }
  const observed = await call('session_observe',{sessionId:state.sessionId});
  assert.equal(observed.update.kind,'snapshot');
  assert.ok(observed.observation.neighborhood);
  const {neighborhood, ...perception} = observed.observation;
  assert.deepEqual(state.observation,perception,'C deltas materialize the actual engine observation');
  reader.apply(observed);
  const afterFull = await call('game_wait',{sessionId:state.sessionId,requestId:'after-full',expectedRevision:observed.revision});
  assert.ok(afterFull.update.remove.includes('neighborhood'));
  assert.equal(reader.apply(afterFull).observation.neighborhood,undefined);
  assert.throws(()=>new CompactObservationReader().apply(delta),/baseline/);
});
