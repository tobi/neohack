// Explicit release check: make bundle, then node --test tests/mcp-bundle.check.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, copyFile, chmod, readdir, readFile, writeFile, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { tools } from '../dist/mcp/agent-data.js';
import { startMcpHttp, HTTP_PROTOCOL_VERSION } from './mcp-fixture.mjs';
const binary = process.env.NEONETHACK_MCP_TEST_EXECUTABLE ?? resolve(import.meta.dirname,'../build/bundle/neohack-mcp');
const identity = { name: 'Bundle', seed: 42, role: 'valkyrie', race: 'dwarf', gender: 'female', align: 'lawful' };

async function fixture(t) {
  const home = await mkdtemp(`${tmpdir()}/neohack-bundle-`), command = `${home}/mcp`;
  await copyFile(binary,command); await chmod(command,0o755);
  const env = { HOME: home, XDG_CACHE_HOME: `${home}/cache`, XDG_STATE_HOME: `${home}/state`, PATH: '/nonexistent' };
  const clients = [];
  t.after(async () => { for (const client of clients) await client.close(); await rm(home,{ recursive:true,force:true }); });
  async function connect(args = []) {
    const client = new Client({name:'bundle-test',version:'1'});
    clients.push(client);
    const transport = new StdioClientTransport({command,args,env,stderr:'pipe'});
    let errors = ''; transport.stderr?.on('data',data => { errors += data; });
    try { await client.connect(transport); } catch (e) { throw new Error(`${e.message}: ${errors}`); }
    return client;
  }
  const call = async (client,name,args) => {
    const result = await client.callTool({name,arguments:args});
    assert.equal(result.isError,false,JSON.stringify(result)); return result.structuredContent;
  };
  return { home,command,env,connect,call };
}

test('relocated static bundle: concurrent cold extraction, distinct games, exact receipts and resume', {timeout:60000}, async t => {
  const f = await fixture(t);
  const headers = spawnSync('readelf',['-l',f.command],{encoding:'utf8'});
  assert.equal(headers.status,0); assert.doesNotMatch(headers.stdout,/INTERP/);
  const [a,b] = await Promise.all([f.connect(),f.connect([`${f.home}/other-sessions`])]);
  assert.deepEqual((await a.listTools()).tools,tools);
  const [one,two] = await Promise.all([f.call(a,"create",identity),f.call(b,"create",identity)]);
  assert.notEqual(one.sessionId,two.sessionId);
  const runtimes = (await readdir(`${f.home}/cache/neohack/runtimes`)).filter(n=>!n.startsWith('.'));
  assert.equal(runtimes.length,1);
  const runtime = `${f.home}/cache/neohack/runtimes/${runtimes[0]}`;
  const engineHeaders = spawnSync('readelf',['-l',`${runtime}/engine`],{encoding:'utf8'});
  assert.equal(engineHeaders.status,0); assert.doesNotMatch(engineHeaders.stdout,/INTERP/);
  const state = `${f.home}/state/neohack/sessions/${one.sessionId}`;
  assert.ok((await readdir(state)).includes('engine'));
  assert.ok((await readdir(`${f.home}/other-sessions/${two.sessionId}`)).includes('engine'));
  const pin = await readFile(`${state}/engine`);
  const args = {sessionId:one.sessionId};
  const prayer = await f.call(a,"pray",args);
  assert.equal(prayer.decision.kind,'confirmation');
  assert.deepEqual((await f.call(a,'receipt',{...args,operationId:prayer.operationId})).observation,prayer.observation);
  await f.call(a,"suspend",{sessionId:one.sessionId});
  await a.close();
  const restarted = await f.connect();
  const resumed = await f.call(restarted,"resume",{sessionId:one.sessionId});
  assert.equal(resumed.decision.id,prayer.decision.id);
  assert.deepEqual(await readFile(`${state}/engine`),pin);
  assert.deepEqual((await f.call(restarted,'receipt',{...args,operationId:prayer.operationId})).observation,prayer.observation);
  await f.call(restarted,"suspend",{sessionId:one.sessionId});
  await f.call(b,"suspend",{sessionId:two.sessionId});
});

test('published runtime corruption and symlink caches fail without silent repair', {timeout:30000}, async t => {
  const f = await fixture(t);
  const client = await f.connect(); await client.close();
  const id = (await readdir(`${f.home}/cache/neohack/runtimes`)).find(n=>!n.startsWith('.'));
  const data = `${f.home}/cache/neohack/runtimes/${id}/nhdat`;
  await chmod(data,0o600); await writeFile(data,'corrupt'); await chmod(data,0o400);
  const broken = spawnSync(f.command,[],{env:f.env,input:'',encoding:'utf8'});
  assert.equal(broken.status,1); assert.match(broken.stderr,/never repaired automatically/);
  assert.equal(await readFile(data,'utf8'),'corrupt');
  await mkdir(`${f.home}/outside`);
  await symlink(`${f.home}/outside`,`${f.home}/linked-cache`);
  const linked = spawnSync(f.command,[],{env:{...f.env,XDG_CACHE_HOME:`${f.home}/linked-cache`},input:'',encoding:'utf8'});
  assert.equal(linked.status,1);
  assert.deepEqual(await readdir(`${f.home}/outside`),[]);
});

test('bundled HTTP starts with only a session path and exposes unchanged tools', {timeout:30000}, async t => {
  const f = await fixture(t);
  const server = await startMcpHttp({mcpCommand:f.command,bundled:true,sessionsPath:`${f.home}/http-games`,env:f.env});
  t.after(()=>server.close());
  let id = 0;
  async function rpc(method,params) {
    const response = await fetch(server.url,{method:'POST',headers:{
      'Content-Type':'application/json',Accept:'application/json, text/event-stream',
      'MCP-Protocol-Version':HTTP_PROTOCOL_VERSION,'Mcp-Method':method,
      ...(params.name ? {'Mcp-Name':params.name} : {}),
    },body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params:{...params,_meta:{
      'io.modelcontextprotocol/protocolVersion':HTTP_PROTOCOL_VERSION,
      'io.modelcontextprotocol/clientCapabilities':{},
    }}})});
    assert.equal(response.status,200); const result = (await response.json()).result;
    assert.ok(result); assert.ok(!result.isError,JSON.stringify(result)); return result;
  }
  assert.deepEqual((await rpc('tools/list',{})).tools,tools);
  const games = await Promise.all([1,2].map(()=>rpc('tools/call',{name:"create",arguments:identity})));
  assert.notEqual(games[0].structuredContent.sessionId,games[1].structuredContent.sessionId);
  for (const game of games) await rpc('tools/call',{name:"suspend",arguments:{sessionId:game.structuredContent.sessionId}});
  await server.close();
});

test('single file runs real games in a scratch container without system libraries or account files', {timeout:60000}, async t => {
  const f = await fixture(t), image = `localhost/neohack-mcp-check-${f.home.split('/').at(-1).toLowerCase()}`;
  await writeFile(`${f.home}/Containerfile`,'FROM scratch\nCOPY mcp /mcp\nENV HOME=/tmp\nENTRYPOINT ["/mcp"]\n');
  const build = spawnSync('podman',['build','-q','-t',image,'-f',`${f.home}/Containerfile`,f.home],{encoding:'utf8',timeout:30000});
  assert.equal(build.status,0,build.stderr);
  t.after(()=>spawnSync('podman',['rmi','-f',image],{encoding:'utf8'}));
  const client = new Client({name:'scratch-test',version:'1'});
  const transport = new StdioClientTransport({command:'podman',args:['run','--rm','-i','--network=none',image],stderr:'pipe'});
  t.after(()=>client.close());
  await client.connect(transport);
  assert.deepEqual((await client.listTools()).tools,tools);
  const games = await Promise.all([1,2].map(()=>client.callTool({name:"create",arguments:identity})));
  for (const game of games) {
    assert.equal(game.isError,false,JSON.stringify(game));
    assert.ok(game.structuredContent.observation.world.length);
    const closed = await client.callTool({name:"suspend",arguments:{sessionId:game.structuredContent.sessionId}});
    assert.equal(closed.isError,false);
  }
  await client.close();
});
