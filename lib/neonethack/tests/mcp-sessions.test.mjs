import { test } from 'node:test';
import assert from 'node:assert/strict';
const perceivedFrame=({neighborhood,...frame})=>frame;
import { mkdtemp, readFile, readlink, rm, stat, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {execFileSync} from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { root, identity } from './native-fixture.mjs';
import { startMcpHttp, HTTP_PROTOCOL_VERSION } from './mcp-fixture.mjs';

async function fixture(t, sessionsPath, env) {
  const server = await startMcpHttp({ enginePath: `${root}/engine/playground/nethack`,
    dataPath: `${root}/engine/playground`, sessionsPath, env });
  t.after(() => server.close());
  let id = 0;
  return { ...server, call: async (name, args = {}, signal) => {
    const response = await fetch(server.url, { method: 'POST', signal, headers: {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': HTTP_PROTOCOL_VERSION, 'Mcp-Method': 'tools/call', 'Mcp-Name': name,
    }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args,
      _meta: { 'io.modelcontextprotocol/protocolVersion': HTTP_PROTOCOL_VERSION, 'io.modelcontextprotocol/clientCapabilities': {} },
    } }) });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body.result;
  } };
}
async function owner(serverPid, sessionId) {
  const children = (await readFile(`/proc/${serverPid}/task/${serverPid}/children`, 'utf8')).trim().split(/\s+/);
  for (const pid of children) {
    for (const fd of await readdir(`/proc/${pid}/fd`)) {
      const path = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '');
      if (path.endsWith(`/${sessionId}/.lease`)) return Number(pid);
    }
  }
  throw Error(`No worker owns ${sessionId}`);
}

test('concurrent native creates publish one immutable engine cache pin and distinct game directories', { timeout: 60000 }, async t => {
  const dir = await mkdtemp(`${tmpdir()}/neonethack-cache-concurrency-`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (let round = 0; round < 8; round++) {
    const sessionsPath = `${dir}/${round}`;
    const server = await fixture(t, sessionsPath);
    try {
      const results = await Promise.all(Array.from({ length: 4 }, () => server.call('session_create', identity)));
      const states = results.map(result => result.structuredContent);
      assert.equal(new Set(states.map(s => s.sessionId)).size, 4);
      const [cache] = await readdir(`${sessionsPath}/.engines`);
      const pinned = await stat(`${sessionsPath}/.engines/${cache}`);
      const pids = new Set();
      for (const state of states) {
        assert.equal(state.error, undefined, JSON.stringify(state.error));
        const engine = await stat(`${sessionsPath}/${state.sessionId}/engine`);
        assert.equal(engine.ino, pinned.ino, 'every game pins the published immutable inode');
        assert.equal(engine.dev, pinned.dev);
        pids.add(await owner(server.process.pid, state.sessionId));
      }
      assert.equal(pids.size, 4, 'dedicated C worker per game');
    } finally { await server.close(); }
  }
});

test('HTTP disconnect preserves accepted input and SIGTERM drains a pending decision answer', { timeout: 30000 }, async t => {
  const sessionsPath = await mkdtemp(`${tmpdir()}/neonethack-http-disconnect-`);
  const server = await fixture(t, sessionsPath);
  t.after(() => rm(sessionsPath, { recursive: true, force: true }));
  const a = (await server.call('session_create', identity)).structuredContent;
  const pid = await owner(server.process.pid, a.sessionId);
  t.after(() => { try { process.kill(pid, 'SIGCONT'); } catch {} });
  process.kill(pid, 'SIGSTOP');
  const abort = new AbortController();
  const args = { sessionId: a.sessionId };
  const lost = server.call('game_pray', args, abort.signal);
  const rejected = assert.rejects(lost, /abort/i);
  await delay(30);
  abort.abort();
  await rejected;
  process.kill(pid, 'SIGCONT');
  const prayer = (await server.call('session_observe', { sessionId: a.sessionId })).structuredContent;
  assert.equal(prayer.decision.kind, 'confirmation');
  assert.equal((await server.call('retry', args)).structuredContent.revision, prayer.revision);
  process.kill(pid, 'SIGSTOP');
  const answer = server.call('decision_answer', { sessionId: a.sessionId, decisionId: prayer.decision.id, answer: { kind: 'confirmation', confirm: false } });
  await delay(30);
  server.process.kill('SIGTERM');
  await delay(10);
  process.kill(pid, 'SIGCONT');
  const completed = await answer;
  assert.equal(completed.isError, false);
  assert.equal(completed.structuredContent.decision, null);
  await server.close();
});

test('stalled/crashed C worker cannot block another game; overlapping HTTP calls preserve exact receipts', { timeout: 30000 }, async t => {
  const sessionsPath = await mkdtemp(`${tmpdir()}/neonethack-worker-fault-`);
  t.after(() => rm(sessionsPath, { recursive: true, force: true }));
  const server = await fixture(t, sessionsPath);
  const [a, b] = (await Promise.all([server.call('session_create', identity), server.call('session_create', identity)])).map(r => r.structuredContent);
  const pid = await owner(server.process.pid, a.sessionId);
  process.kill(pid, 'SIGSTOP');
  t.after(() => { try { process.kill(pid, 'SIGCONT'); } catch {} });
  const args = { sessionId: a.sessionId };
  let completed = false;
  const pending = server.call('game_pray', args).then(r => { completed = true; return r; });
  const receipt = server.call('retry', args);
  const observed = await server.call('session_observe', { sessionId: b.sessionId });
  assert.equal(observed.isError, false);
  assert.equal(observed.structuredContent.revision, b.revision);
  assert.equal(completed, false, 'second game replies while first worker is stopped');
  process.kill(pid, 'SIGCONT');
  const prayer = await pending;
  assert.equal(prayer.structuredContent.decision.kind, 'confirmation');
  const concurrentRetry = await receipt;
  // Separate HTTP connections can arrive in either order. A retry received
  // before the first input must report that nothing is retained, not invent one.
  if (concurrentRetry.isError) {
    assert.equal(concurrentRetry.structuredContent.error.code, 'agentError');
    assert.equal(concurrentRetry.structuredContent.error.message, 'No recent input is retained. Inspect a receipt by operationId.');
  } else {
    assert.deepEqual(perceivedFrame(concurrentRetry.structuredContent.observation),perceivedFrame(prayer.structuredContent.observation), 'queued recovery reads the completed receipt');
  }
  assert.deepEqual(perceivedFrame((await server.call('retry', args)).structuredContent.observation),perceivedFrame(prayer.structuredContent.observation), 'recovery after completion always reads the exact receipt');
  process.kill(pid, 'SIGSTOP');
  const uncertain = server.call('session_observe', { sessionId: a.sessionId });
  // Give the parent time to queue the request before terminating its worker.
  await delay(30);
  process.kill(pid, 'SIGKILL');
  const failure = await uncertain;
  assert.equal(failure.isError, true);
  assert.equal(failure.structuredContent.error.code,'uncertainExecution');
  assert.equal((await server.call('session_observe', { sessionId: b.sessionId })).isError, false);
  const unloaded = await server.call('session_observe', { sessionId: a.sessionId });
  assert.equal(unloaded.isError, true, 'observations never implicitly resume a crashed worker');
  const resumed = await server.call('session_resume', { sessionId: a.sessionId });
  assert.equal(resumed.isError, false, JSON.stringify(resumed));
  assert.deepEqual(resumed.structuredContent.decision, prayer.structuredContent.decision);
  assert.notEqual(await owner(server.process.pid, a.sessionId), pid);
  assert.deepEqual(perceivedFrame((await server.call('receipt',{...args,operationId:prayer.structuredContent.operationId})).structuredContent.observation),perceivedFrame(prayer.structuredContent.observation));
});

for(const mode of ['http','stdio'])test(`${mode}: close bounds idle stopped worker shutdown and releases its run for a fresh server`, {timeout:15000}, async t=>{
  const sessionsPath=await mkdtemp(`${tmpdir()}/neonethack-idle-shutdown-`);
  t.after(()=>rm(sessionsPath,{recursive:true,force:true}));
  let server;
  if(mode==='http')server=await fixture(t,sessionsPath);
  else {
    const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
    const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
    const client=new Client({name:'shutdown-contract',version:'1'});
    const transport=new StdioClientTransport({command:`${root}/build/native/neonethack-mcp`,args:[`${root}/engine/playground/nethack`,`${root}/engine/playground`,sessionsPath],stderr:'pipe'});
    await client.connect(transport);
    server={process:{pid:transport.pid},close:()=>client.close(),call:(name,args)=>client.callTool({name,arguments:args})};
    t.after(()=>server.close());
  }
  const created=(await server.call('session_create',identity)).structuredContent;
  const second=(await server.call('session_create',identity)).structuredContent;
  const pids=await Promise.all([created,second].map(r=>owner(server.process.pid,r.sessionId)));
  const independent=await fixture(t,sessionsPath);
  const other=(await independent.call('session_create',identity)).structuredContent;
  let stopped=true;
  // Always release the fault before fixture cleanup, including on an old binary
  // whose shutdown otherwise waits forever. This is an idle worker, not input.
  try {
    for(const pid of pids)process.kill(pid,'SIGSTOP');
    const started=Date.now();
    const closed=server.close().then(()=>true);
    const bounded=await Promise.race([closed,delay(5000).then(()=>false)]);
    assert.equal(bounded,true,'server must retire a stopped idle worker without external SIGCONT');
    assert.ok(Date.now()-started<5000);
    stopped=false;
    for(const pid of pids)assert.throws(()=>process.kill(pid,0),{code:'ESRCH'},'server reaps its worker before exit');
    const unaffected=(await independent.call('game_wait',{sessionId:other.sessionId})).structuredContent;
    assert.equal(unaffected.observation.turn,other.observation.turn+1,'fallback cannot signal another server’s worker group');
    const fresh=await fixture(t,sessionsPath);
    const resumed=(await fresh.call('session_resume',{sessionId:created.sessionId})).structuredContent;
    assert.ok(!resumed.error,JSON.stringify(resumed.error));
    assert.deepEqual(perceivedFrame(resumed.observation),perceivedFrame(created.observation));
    assert.equal(resumed.revision,created.revision,'shutdown injected no gameplay input');
  } finally {if(stopped)for(const pid of pids)try{process.kill(pid,'SIGCONT');}catch{}}
});

test('shutdown waits for accepted navigation before starting idle retirement grace', {timeout:15000}, async t=>{
  const directory=await mkdtemp(`${tmpdir()}/neonethack-active-shutdown-`);
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const armed=`${directory}/stop-reply`,interposer=`${directory}/stop.so`;
  execFileSync(process.env.CC??'cc',['-shared','-fPIC',`${root}/tests/mcp-reply-stop.c`,'-ldl','-o',interposer]);
  const sessionsPath=`${directory}/sessions`;
  const server=await fixture(t,sessionsPath,{...process.env,LD_PRELOAD:interposer,NNH_TEST_STOP_REPLY:armed});
  const created=(await server.call('session_create',identity)).structuredContent;
  const sid={sessionId:created.sessionId},pid=await owner(server.process.pid,created.sessionId);
  try {
    await writeFile(armed,'pause only after an actual input commits');
    const navigation=server.call('explore',{...sid,maxActions:3});
    let stopped=false;
    for(let i=0;i<300;i++){if(/^State:\s+T/m.test(await readFile(`/proc/${pid}/status`,'utf8'))){stopped=true;break;}await delay(10);}
    assert.ok(stopped,'navigation committed a real substep before shutdown');
    const closing=server.close();
    await delay(3300);
    assert.equal(server.process.exitCode,null,'accepted navigation is not subject to idle shutdown grace');
    assert.equal(server.process.signalCode,null);
    process.kill(pid,'SIGCONT');
    const completed=(await navigation).structuredContent;assert.ok(!completed.error,JSON.stringify(completed.error));
    assert.equal(completed.navigation.actionsTaken,3);assert.equal(completed.observation.turn,created.observation.turn+3);
    await closing;
    const fresh=await fixture(t,sessionsPath);
    const resumed=(await fresh.call('session_resume',sid)).structuredContent;
    assert.equal(resumed.observation.turn,completed.observation.turn);
    const exact=(await fresh.call('receipt',{...sid,operationId:completed.operationId})).structuredContent;
    assert.equal(exact.operationId,completed.operationId);assert.deepEqual(perceivedFrame(exact.observation),perceivedFrame(completed.observation));
  } finally {try{process.kill(pid,'SIGCONT');}catch{}}
});
