import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readlink, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { root, identity } from './native-fixture.mjs';
import { startMcpHttp, HTTP_PROTOCOL_VERSION } from './mcp-fixture.mjs';

async function fixture(t, sessionsPath) {
  const server = await startMcpHttp({ enginePath: `${root}/engine/playground/nethack`,
    dataPath: `${root}/engine/playground`, sessionsPath });
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
  const answer = server.call('decision_answer', { sessionId: a.sessionId, answer: { kind: 'confirmation', confirm: false } });
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
    assert.deepEqual(concurrentRetry.structuredContent.observation, prayer.structuredContent.observation, 'queued recovery reads the completed receipt');
  }
  assert.deepEqual((await server.call('retry', args)).structuredContent.observation, prayer.structuredContent.observation, 'recovery after completion always reads the exact receipt');
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
  assert.deepEqual((await server.call('receipt',{...args,operationId:prayer.structuredContent.operationId})).structuredContent.observation,prayer.structuredContent.observation);
});
