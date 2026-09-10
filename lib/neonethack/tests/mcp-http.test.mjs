import { test } from 'node:test';
import assert from 'node:assert/strict';
const perceivedFrame=({neighborhood,...frame})=>frame;
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import Ajv from 'ajv/dist/2020.js';
import { startMcpHttp, mcpExecutable, HTTP_PROTOCOL_VERSION } from './mcp-fixture.mjs';
import { tools } from '../dist/mcp/agent-data.js';
import { root, identity } from './native-fixture.mjs';

const validate = new Ajv({strict:false}).compile(JSON.parse(await readFile(new URL('../protocol/response.schema.json',import.meta.url),'utf8')));
const meta = {
  'io.modelcontextprotocol/protocolVersion': HTTP_PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'http-test', version: '1' },
};
async function fixture(t) {
  const sessionsPath = await mkdtemp(`${tmpdir()}/neonethack-http-`);
  const options = { executable: `${root}/build/native/neonethack`,
    enginePath: `${root}/engine/playground/nethack`, dataPath: `${root}/engine/playground`, sessionsPath };
  let server = await startMcpHttp(options);
  t.after(async () => { await server.close(); await rm(sessionsPath, { recursive: true, force: true }); });
  let id = 0;
  const rpc = async (method, params = {}, overrides = {}) => {
    const body = { jsonrpc: '2.0', id: ++id, method, params: { _meta: meta, ...params } };
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': HTTP_PROTOCOL_VERSION, 'Mcp-Method': method,
      ...(params.name ? { 'Mcp-Name': params.name } : {}), ...overrides.headers };
    const response = await fetch(server.url, { method: 'POST', ...overrides, headers,
      body: overrides.body ?? JSON.stringify(body) });
    return { status: response.status, headers: response.headers, body: await response.json().catch(() => ({})) };
  };
  const call = async (name, args) => {
    const response = await rpc('tools/call', { name, arguments: args });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const result = response.body.result;
    assert.equal(result.resultType, 'complete');
    assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent);
    const {summary,creatures,operationId,historical,navigation,presentation,...low}=result.structuredContent;
    if(low.observation)low.requestId=operationId??null;
    assert.equal(typeof summary,'string');
    if(!presentation)assert.ok(validate(low),JSON.stringify(validate.errors));else {assert.equal(presentation.kind,'compact');assert.ok(low.observation.world);assert.equal(low.observation.neighborhood,undefined);}
    assert.equal(result.structuredContent.update,undefined);
    return result.structuredContent;
  };
  return { rpc, call, sessionsPath, get url() { return server.url; },
    restart: async () => { await server.close(); server = await startMcpHttp(options); } };
}

test('HTTP modern metadata, discovery, unchanged tool catalog and wire validation', async t => {
  const { rpc, url } = await fixture(t);
  const discovered = await rpc('server/discover');
  assert.equal(discovered.status, 200);
  assert.deepEqual(discovered.body.result.supportedVersions, [HTTP_PROTOCOL_VERSION]);
  assert.deepEqual(discovered.body.result.capabilities, { tools: {} });
  assert.equal(discovered.headers.get('mcp-session-id'), null);
  assert.deepEqual((await rpc('tools/list')).body.result.tools, tools);
  const cases = [
    ['tools/list', {}, { headers: { 'Mcp-Method': 'tools/call' } }, 400, -32020],
    ['tools/list', {}, { headers: { 'MCP-Protocol-Version': '2025-11-25' } }, 400, -32020],
    ['tools/list', { _meta: { ...meta, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } },
      { headers: { 'MCP-Protocol-Version': '2099-01-01' } }, 400, -32022],
    ['tools/list', { _meta: {} }, {}, 400, -32602],
    ['tools/list', {}, { headers: { Accept: 'application/json' } }, 406, -32600],
    ['tools/list', {}, { headers: { 'Content-Type': 'text/plain' } }, 415, -32600],
    ['tools/list', {}, { headers: { Origin: 'https://evil.example' } }, 403, -32600],
    ['tools/list', {}, { body: '[' }, 400, -32700],
    ['tools/list', {}, { body: '[]' }, 400, -32600],
    ['tools/list', {}, { body: JSON.stringify({ jsonrpc: '2.0', id: null, method: 'tools/list' }) }, 400, -32600],
    ['tools/list', {}, { body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) }, 400, -32600],
    ['tools/call', { name: "create" }, { headers: { 'Mcp-Name': "wait" } }, 400, -32020],
    ['tools/call', { name: "create", arguments: [] }, {}, 400, -32602],
    ['tools/call', { name: 'missing' }, {}, 400, -32602],
    ['unknown', {}, {}, 404, -32601],
    ['initialize', {}, {}, 404, -32601],
    ['tools/list', {}, { body: ' '.repeat(65537) }, 413, -32600],
  ];
  for (const [method, params, overrides, status, code] of cases) {
    const response = await rpc(method, params, overrides);
    assert.equal(response.status, status, `${method}: ${JSON.stringify(response.body.error)}`);
    if (status !== 413) assert.equal(response.body.error.code, code);
  }
  // Fetch rewrites Host; exercise DNS-rebinding protection on the actual wire.
  await new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'POST', headers: { Host: 'evil.example' } }, res => {
      res.resume();
      res.on('end', () => { try { assert.equal(res.statusCode, 403); resolve(); } catch (error) { reject(error); } });
    });
    req.on('error', reject);
    req.end();
  });
  for (const method of ['GET', 'DELETE']) {
    const response = await fetch(url, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
    await response.text();
  }
  const encoded = await rpc('tools/call', { name: 'help' }, {
    headers: { 'Mcp-Name': `=?base64?${Buffer.from('help').toString('base64')}?=` },
  });
  assert.equal(encoded.status, 200);
  const notification = await rpc('tools/call', {}, { body: JSON.stringify({ jsonrpc: '2.0',
    method: 'tools/call', params: { name: "create", arguments: identity } }) });
  assert.equal(notification.status, 400);
});

test('HTTP concurrent games have dedicated state directories, exact receipts and explicit resume', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([
    f.call("create", identity), f.call("create", { ...identity, name: 'Second' }),
  ]);
  assert.equal(a.error, undefined);
  assert.equal(b.error, undefined);
  assert.notEqual(a.sessionId, b.sessionId);
  for (const state of [a, b]) {
    const files = await readdir(`${f.sessionsPath}/runs/${state.sessionId}`);
    assert.ok(files.includes('journal.sqlite'));
    assert.ok(files.includes('runtime.json'));
  }
  const bBefore = await f.call("observe",{sessionId:b.sessionId});
  const args = { sessionId: a.sessionId };
  const [prayer, observed] = await Promise.all([f.call("pray", args), f.call("observe", { sessionId: b.sessionId })]);
  assert.equal(prayer.decision.kind, 'confirmation');
  assert.equal(observed.revision, b.revision);
  assert.equal(observed.decision, null);
  assert.deepEqual((await f.call("observe",{sessionId:b.sessionId})).observation,bBefore.observation);
  assert.deepEqual(perceivedFrame((await f.call('receipt', {...args,operationId:prayer.operationId})).observation),perceivedFrame(prayer.observation));
  const bad = await f.rpc('tools/call',{name:"wait",arguments:{...args,requestId:'caller-guard'}});
  assert.equal(bad.status,200);assert.equal(bad.body.result.structuredContent.error.code,'invalidParams','MCP rejects caller-owned guards before input');
  await f.call("suspend", { sessionId: a.sessionId });
  assert.ok((await f.call("observe", { sessionId: a.sessionId })).error);
  const resumed = await f.call("resume", { sessionId: a.sessionId });
  assert.deepEqual(resumed.decision, prayer.decision);
  assert.deepEqual(perceivedFrame((await f.call('receipt', {...args,operationId:prayer.operationId})).observation),perceivedFrame(prayer.observation));
  await f.restart();
  const [ra, rb] = await Promise.all([a, b].map(state => f.call("resume", { sessionId: state.sessionId })));
  assert.deepEqual(ra.decision, prayer.decision);
  assert.equal(rb.revision, b.revision);
  const decline = await f.call("answer", { sessionId: ra.sessionId, decisionId: ra.decision.id, value: false });
  assert.equal(decline.error, undefined);
  assert.equal(decline.decision, null);
});

test('CLI --http selects HTTP and SIGTERM releases child leases for a fresh server', { timeout: 30000 }, async t => {
  const sessionsPath = await mkdtemp(`${tmpdir()}/neonethack-http-cli-`);
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(mcpExecutable, ['--http', String(port),
    '--sessions',sessionsPath],
    { env: { ...process.env, NEONETHACK_EXECUTABLE: `${root}/build/native/neonethack` }, stdio: 'pipe' });
  const exit = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exit;
    await rm(sessionsPath, { recursive: true, force: true });
  });
  let stdout = '';
  child.stdout.on('data', data => { stdout += data; });
  const lines = createInterface({ input: child.stderr });
  const ready = once(lines, 'line');
  const [line] = await Promise.race([ready, exit.then(() => { throw Error('CLI exited before listening'); })]);
  assert.match(line, /MCP listening/);
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': HTTP_PROTOCOL_VERSION, 'Mcp-Method': 'tools/call', 'Mcp-Name': "create" },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { _meta: meta, name: "create", arguments: identity } }),
  });
  assert.equal(response.status, 200);
  const state = (await response.json().catch(() => ({}))).result.structuredContent;
  assert.equal(state.error, undefined);
  child.kill('SIGTERM');
  assert.deepEqual(await exit, [0, null]);
  assert.equal(stdout, '', 'HTTP never emits stdio protocol frames');
  const replacement=await startMcpHttp({sessionsPath});
  try {
    const reply=await fetch(replacement.url,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'resume',arguments:{sessionId:state.sessionId}}})});
    const resumed=(await reply.json()).result.structuredContent;
    assert.equal(resumed.error,undefined);assert.equal(resumed.revision,state.revision);
  }finally{await replacement.close();}

});

test('HTTP routes use the returned short run token without consuming input', async t => {
  const {call} = await fixture(t);
  const state = await call("create", identity);
  assert.match(state.sessionId,/^[A-Za-z0-9_-]{16}$/);
  const {x,y} = state.observation.you;
  const route = await call("route",{sessionId:state.sessionId,to:{x,y}});
  assert.equal(route.kind,'route');
  assert.equal(route.distance,0);
  assert.deepEqual(route.steps,[]);
  const observed = await call("observe",{sessionId:state.sessionId});
  assert.equal(observed.revision,state.revision);
  assert.equal(observed.observation.turn,state.observation.turn);
});

for(const version of ['2025-03-26','2025-06-18','2025-11-25']) test('HTTP earlier handshake and gameplay '+version,async t=>{
  const {url}=await fixture(t);let id=0;
  const send=async(method,params={},notification=false)=>{
    const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',...(method==='initialize'?{}:{'MCP-Protocol-Version':version})},body:JSON.stringify({jsonrpc:'2.0',...(!notification?{id:++id}:{}),method,params})});
    const text=await response.text();return {status:response.status,body:text?JSON.parse(text):null};
  };
  const init=await send('initialize',{protocolVersion:version,clientInfo:{name:'older-client',version:'1'},capabilities:{}});
  assert.equal(init.status,200);assert.equal(init.body.result.protocolVersion,version);assert.equal(init.body.result.resultType,undefined);
  assert.deepEqual(await send('notifications/initialized',{},true),{status:202,body:null});
  assert.deepEqual((await send('tools/list')).body.result.tools,tools);
  const created=await send('tools/call',{name:"create",arguments:{name:'Earlier',role:'wizard',seed:42}});
  assert.equal(created.status,200);assert.equal(created.body.result.isError,false,JSON.stringify(created));
  const game=created.body.result.structuredContent;
  assert.deepEqual(JSON.parse(created.body.result.content[0].text),game);
  assert.ok(game.sessionId);assert.equal(created.body.result.resultType,undefined);
  const observed=await send('tools/call',{name:"observe",arguments:{sessionId:game.sessionId}});
  assert.equal(observed.body.result.isError,false,JSON.stringify(observed));
  assert.equal(observed.body.result.structuredContent.sessionId,game.sessionId);
});

test('HTTP destination walking crosses the old eight-action limit',async t=>{
  const {call}=await fixture(t);
  const game=await call("create",{name:'Range',role:'valkyrie',seed:1});
  const sessionId=game.sessionId;
  await call('explore',{sessionId,maxActions:8});await call('explore',{sessionId,maxActions:8});
  const result=await call('go',{sessionId,to:{x:43,y:8}});
  assert.equal(result.navigation.reason,'arrived');assert.ok(result.navigation.actionsTaken>8);
  assert.deepEqual({x:result.observation.you.x,y:result.observation.you.y},{x:43,y:8});
});
