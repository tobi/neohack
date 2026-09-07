import { test } from 'node:test';
import assert from 'node:assert/strict';
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
import { NativeTransport } from '../dist/typescript/native.js';

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
    assert.deepEqual(result.content, []);
    const {summary,creatures,operationId,historical,navigation,...low}=result.structuredContent;
    if(low.observation)low.requestId=operationId??null;
    assert.equal(typeof summary,'string');
    assert.ok(validate(low),JSON.stringify(validate.errors));
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
    ['tools/list', { _meta: { ...meta, 'io.modelcontextprotocol/protocolVersion': '2025-11-25' } },
      { headers: { 'MCP-Protocol-Version': '2025-11-25' } }, 400, -32022],
    ['tools/list', { _meta: {} }, {}, 400, -32602],
    ['tools/list', {}, { headers: { Accept: 'application/json' } }, 406, -32600],
    ['tools/list', {}, { headers: { 'Content-Type': 'text/plain' } }, 415, -32600],
    ['tools/list', {}, { headers: { Origin: 'https://evil.example' } }, 403, -32600],
    ['tools/list', {}, { body: '[' }, 400, -32700],
    ['tools/list', {}, { body: '[]' }, 400, -32600],
    ['tools/list', {}, { body: JSON.stringify({ jsonrpc: '2.0', id: null, method: 'tools/list' }) }, 400, -32600],
    ['tools/list', {}, { body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) }, 400, -32600],
    ['tools/call', { name: 'session_create' }, { headers: { 'Mcp-Name': 'game_wait' } }, 400, -32020],
    ['tools/call', { name: 'session_create', arguments: [] }, {}, 400, -32602],
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
    method: 'tools/call', params: { name: 'session_create', arguments: identity } }) });
  assert.equal(notification.status, 400);
});

test('HTTP concurrent games have dedicated state directories, exact receipts and explicit resume', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([
    f.call('session_create', identity), f.call('session_create', { ...identity, name: 'Second' }),
  ]);
  assert.equal(a.error, undefined);
  assert.equal(b.error, undefined);
  assert.notEqual(a.sessionId, b.sessionId);
  for (const state of [a, b]) {
    const files = await readdir(`${f.sessionsPath}/${state.sessionId}`);
    assert.ok(files.includes('input.log.jsonl'));
    assert.ok(files.includes('engine'));
    assert.ok(files.includes('playground'));
  }
  const bJournal = await readFile(`${f.sessionsPath}/${b.sessionId}/input.log.jsonl`, 'utf8');
  const args = { sessionId: a.sessionId };
  const [prayer, observed] = await Promise.all([f.call('game_pray', args), f.call('session_observe', { sessionId: b.sessionId })]);
  assert.equal(prayer.decision.kind, 'confirmation');
  assert.equal(observed.revision, b.revision);
  assert.equal(observed.decision, null);
  assert.equal(await readFile(`${f.sessionsPath}/${b.sessionId}/input.log.jsonl`, 'utf8'), bJournal);
  assert.deepEqual((await f.call('receipt', {...args,operationId:prayer.operationId})).observation,prayer.observation);
  const bad = await f.rpc('tools/call',{name:'game_wait',arguments:{...args,requestId:'caller-guard'}});
  assert.equal(bad.status,400);assert.equal(bad.body.error.code,-32602,'MCP rejects caller-owned guards before input');
  await f.call('session_close', { sessionId: a.sessionId });
  assert.ok((await f.call('session_observe', { sessionId: a.sessionId })).error);
  const resumed = await f.call('session_resume', { sessionId: a.sessionId });
  assert.deepEqual(resumed.decision, prayer.decision);
  assert.deepEqual((await f.call('receipt', {...args,operationId:prayer.operationId})).observation,prayer.observation);
  await f.restart();
  const [ra, rb] = await Promise.all([a, b].map(state => f.call('session_resume', { sessionId: state.sessionId })));
  assert.deepEqual(ra.decision, prayer.decision);
  assert.equal(rb.revision, b.revision);
  const decline = await f.call('decision_answer', { sessionId: ra.sessionId, answer: { kind: 'confirmation', confirm: false } });
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
    `${root}/engine/playground/nethack`, `${root}/engine/playground`, sessionsPath],
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
      'MCP-Protocol-Version': HTTP_PROTOCOL_VERSION, 'Mcp-Method': 'tools/call', 'Mcp-Name': 'session_create' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { _meta: meta, name: 'session_create', arguments: identity } }),
  });
  assert.equal(response.status, 200);
  const state = (await response.json().catch(() => ({}))).result.structuredContent;
  assert.equal(state.error, undefined);
  child.kill('SIGTERM');
  assert.deepEqual(await exit, [0, null]);
  assert.equal(stdout, '', 'HTTP never emits stdio protocol frames');
  const core = new NativeTransport({ executable: `${root}/build/native/neonethack`,
    enginePath: `${root}/engine/playground/nethack`, dataPath: `${root}/engine/playground`, sessionsPath });
  try {
    const resumed = await core.send({ version: 1, method: 'session.resume', params: { sessionId: state.sessionId } });
    assert.equal(resumed.error, undefined);
    assert.equal(resumed.revision, state.revision);
  } finally { await core.close(); }
});

test('HTTP routes use the returned short run token without consuming input', async t => {
  const {call} = await fixture(t);
  const state = await call('session_create', identity);
  assert.match(state.sessionId,/^[A-Za-z0-9_-]{16}$/);
  const {x,y} = state.observation.you;
  const route = await call('session_route',{sessionId:state.sessionId,to:{x,y}});
  assert.equal(route.kind,'route');
  assert.equal(route.distance,0);
  assert.deepEqual(route.steps,[]);
  const observed = await call('session_observe',{sessionId:state.sessionId});
  assert.equal(observed.revision,state.revision);
  assert.equal(observed.observation.turn,state.observation.turn);
});
