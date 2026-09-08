import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter, once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createServer, request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createBridge, BridgeRequestError } from './bridge.mjs';

const request = (id = 'original-rpc-id') => ({ jsonrpc: '2.0', id, method: 'tools/call',
  params: { name: 'fixture_input', arguments: { sessionId: 'disposable',
    requestId: 'semantic-original', decisionId: 'exact-decision' } } });
const reader = `const {createInterface}=require('node:readline');
  createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);`;
function setup(t, script, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'neo53-'));
  const journalPath = join(dir, 'bridge.jsonl');
  const bridge = createBridge({ command: process.execPath, args: ['-e', script],
    journalPath, timeoutMs: 1500, closeGraceMs: 150, ...options });
  t.after(async () => { await bridge.close(); rmSync(dir, { recursive: true, force: true }); });
  return { bridge, records: () => readFileSync(journalPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) };
}
function rejectsUncertain(promise, reason) {
  return assert.rejects(promise, error => {
    assert.ok(error instanceof BridgeRequestError);
    assert.equal(error.classification, 'execution_uncertain');
    if (reason) assert.match(error.reason, reason);
    assert.equal(error.record.requestId, 'original-rpc-id');
    assert.equal(error.toJSON().retry, false);
    return true;
  });
}
async function until(predicate) {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'fixture did not reach expected condition');
    await delay(10);
  }
}

test('exact envelope, original tokens, request-before-dispatch and no id reuse', async t => {
  const { bridge, records } = setup(t, `${reader}
    if(r.id!==undefined) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,
      result:{structuredContent:r.params,content:[],isError:false}})+'\\n'); });`);
  const call = request();
  const result = await bridge.rpc(call);
  assert.deepEqual(result, { jsonrpc: '2.0', id: call.id,
    result: { structuredContent: call.params, content: [], isError: false } });
  await assert.rejects(bridge.rpc(call), /already used/);
  await bridge.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const rows = records();
  assert.deepEqual(rows[0].message, call);
  assert.equal(rows[1].kind, 'dispatch');
  assert.equal(rows[2].kind, 'response');
  assert.equal(bridge.pendingCount, 0);
});

test('ENOENT spawn is handled and pending requests settle once', async t => {
  const { bridge, records } = setup(t, '', { command: '/no/such/neo53-executable' });
  const outcomes = await Promise.allSettled([bridge.rpc(request()), bridge.rpc(request('second'))]);
  assert.ok(outcomes.every(o => o.status === 'rejected' && o.reason instanceof BridgeRequestError));
  assert.ok(outcomes.every(o => o.reason.classification === 'not_sent'));
  assert.equal(bridge.pendingCount, 0);
  await bridge.close();
  assert.equal(records().filter(r => r.kind === 'settled').length, 2);
});

test('early child exit rejects all concurrent pending requests exactly once', async t => {
  const { bridge, records } = setup(t, `${reader} process.exit(17); });`);
  const first = rejectsUncertain(bridge.rpc(request()), /closed|exit/);
  const second = assert.rejects(bridge.rpc(request('second')), BridgeRequestError);
  await Promise.all([first, second]);
  await bridge.close();
  assert.equal(records().filter(r => r.kind === 'settled').length, 2);
  assert.equal(bridge.pendingCount, 0);
});

test('closed stdout settles input even while child stays alive', async t => {
  const { bridge, records } = setup(t, `${reader}
    process.stdout.end(); setInterval(()=>{},1000); });`);
  await rejectsUncertain(bridge.rpc(request()), /stdout_closed/);
  const result = await bridge.close();
  assert.equal(result.childClosed, true);
  assert.equal(result.ownedProcessesRemaining, false);
  assert.equal(records().filter(r => r.kind === 'settled').length, 1);
});

test('hung child timeout is durable, blocks new input and never retries', async t => {
  const { bridge, records } = setup(t, `${reader} });`, { timeoutMs: 100 });
  await rejectsUncertain(bridge.rpc(request()), /timeout/);
  await assert.rejects(bridge.rpc(request('new-input')), e => e.classification === 'not_sent');
  assert.equal(records().filter(r => r.kind === 'dispatch').length, 1);
  assert.equal(records().find(r => r.kind === 'settled').classification, 'execution_uncertain');
});

test('EPIPE from stdin callback plus error event cannot double-settle or crash', async t => {
  const fake = new EventEmitter();
  fake.stdout = new PassThrough(); fake.stderr = new PassThrough();
  fake.stdin = new Writable({ write(_chunk, _encoding, done) {
    done(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
  } });
  fake.kill = () => { fake.emit('close'); return true; };
  const { bridge, records } = setup(t, '', { spawnChild: () => fake, platform: 'win32' });
  await rejectsUncertain(bridge.rpc(request()), /EPIPE/);
  await delay(10);
  assert.equal(records().filter(r => r.kind === 'settled').length, 1);
  assert.equal(bridge.pendingCount, 0);
});

test('HTTP disconnect cleans pending entry and records late exact response, without replay', async t => {
  const { bridge, records } = setup(t, `${reader}
    process.stderr.write('accepted'); setTimeout(()=>process.stdout.write(
      JSON.stringify({jsonrpc:'2.0',id:r.id,result:{receipt:'fixture-exact'}})+'\\n'),150); });`);
  const server = createServer(bridge.handleHttp);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const req = httpRequest({ host: '127.0.0.1', port: server.address().port, method: 'POST' });
  req.on('error', () => {});
  req.end(JSON.stringify(request()));
  await until(() => records().some(r => r.kind === 'stderr'));
  req.destroy();
  await until(() => records().some(r => r.kind === 'response'));
  assert.equal(bridge.pendingCount, 0);
  const rows = records(), settled = rows.filter(r => r.kind === 'settled');
  assert.equal(settled.length, 1);
  assert.equal(settled[0].reason, 'connection_lost');
  assert.equal(settled[0].classification, 'execution_uncertain');
  const response = rows.find(r => r.kind === 'response');
  assert.equal(response.late, true);
  assert.equal(response.requestSequence, settled[0].requestSequence);
  assert.equal(response.message.result.receipt, 'fixture-exact');
  assert.equal(rows.filter(r => r.kind === 'dispatch').length, 1);
});

test('HTTP failure body preserves uncertainty and original record identity', async t => {
  const { bridge } = setup(t, `${reader} process.exit(1); });`);
  const server = createServer(bridge.handleHttp);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}`, {
    method: 'POST', body: JSON.stringify(request()) });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.classification, 'execution_uncertain');
  assert.equal(body.error.record.requestId, request().id);
  assert.equal(body.error.durability, 'recorded');
  assert.equal(body.error.retry, false);
});

test('shutdown during accepted input awaits close and is idempotent', async t => {
  const { bridge, records } = setup(t, `${reader}
    process.stderr.write('accepted'); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); });`);
  const outcome = rejectsUncertain(bridge.rpc(request()), /deadline/);
  await until(() => records().some(r => r.kind === 'stderr'));
  const closing = bridge.close('deadline');
  assert.equal(bridge.close(), closing);
  const result = await closing;
  await outcome;
  assert.equal(result.childClosed, true);
  assert.equal(result.ownedProcessesRemaining, false);
  assert.equal(records().filter(r => r.kind === 'settled').length, 1);
});

test('POSIX shutdown signals the owned engine descendant as well as MCP', {
  skip: process.platform === 'win32' && 'POSIX process groups only',
}, async t => {
  // Parent reaps its child before exiting so fixture zombies do not depend on PID 1.
  const script = `const {spawn}=require('node:child_process');
    const descendant=spawn(process.execPath,['-e',
      "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"]);
    descendant.on('exit',()=>process.exit(0));
    process.on('SIGTERM',()=>{});
    setTimeout(()=>process.stderr.write('ready'),100);`;
  const { bridge, records } = setup(t, script);
  await until(() => records().some(r => r.kind === 'stderr'));
  const result = await bridge.close();
  assert.equal(result.ownership, 'process_group');
  assert.equal(result.childClosed, true);
  assert.equal(result.ownedProcessesRemaining, false);
});

test('journal failure before dispatch sends nothing and exposes durability failure', async t => {
  const rows = [];
  const { bridge } = setup(t, `${reader} });`, { journal: {
    path: 'injected-failing-journal', append(record) {
      if (record.kind === 'dispatch') throw new Error('disk full'); rows.push(record);
    }, close() {},
  } });
  await assert.rejects(bridge.rpc(request()), error => {
    assert.equal(error.classification, 'not_sent');
    assert.equal(error.durability, 'failed');
    return true;
  });
  assert.equal(bridge.pendingCount, 0);
  assert.equal(rows.filter(r => r.kind === 'response').length, 0);
});

test('aborted before dispatch preserves not_sent and exact snapshot despite caller mutation', async t => {
  const { bridge, records } = setup(t, `${reader} });`);
  const controller = new AbortController(); controller.abort();
  const call = request();
  const result = bridge.rpc(call, { signal: controller.signal });
  call.params.arguments.decisionId = 'changed';
  await assert.rejects(result, error => error.classification === 'not_sent');
  assert.equal(records()[0].message.params.arguments.decisionId, 'exact-decision');
  assert.equal(records().some(r => r.kind === 'dispatch'), false);
});

test('response persistence failure retains uncertainty for the original dispatch', async t => {
  const rows = [];
  const { bridge } = setup(t, `${reader}
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{ok:true}})+'\\n'); });`, {
    journal: { path: 'injected-response-failure', append(record) {
      if (record.kind === 'response' || record.kind === 'settled') throw new Error('disk full');
      rows.push(record);
    }, close() {} },
  });
  await assert.rejects(bridge.rpc(request()), error => {
    assert.equal(error.classification, 'execution_uncertain');
    assert.equal(error.reason, 'journal_failure');
    assert.equal(error.durability, 'failed');
    assert.equal(rows[0].message.id, error.record.requestId);
    return true;
  });
  assert.deepEqual(rows.map(r => r.kind), ['request', 'dispatch']);
  assert.equal(bridge.pendingCount, 0);
});

test('requests after close cannot claim a durable request record', async t => {
  const { bridge } = setup(t, `${reader} });`);
  await bridge.close();
  await assert.rejects(bridge.rpc(request()), error => {
    assert.equal(error.classification, 'not_sent');
    assert.equal(error.durability, 'not_recorded');
    assert.equal(error.record.requestSequence, null);
    return true;
  });
});

test('bounded shutdown reports failed process termination instead of claiming cleanup', async t => {
  const fake = new EventEmitter();
  fake.stdin = new PassThrough(); fake.stdout = new PassThrough(); fake.stderr = new PassThrough();
  const signals = [];
  const { bridge } = setup(t, '', { spawnChild: () => fake,
    signalChild: (_child, signal) => signals.push(signal), ownedAlive: () => true,
    closeGraceMs: 20 });
  const result = await bridge.close();
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(result.childClosed, false);
  assert.equal(result.ownedProcessesRemaining, true);
});

test('local reservation links identical calls to distinct records without modifying wire envelopes', async t => {
  const { bridge, records } = setup(t, `${reader}
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:r})+'\\n'); });`);
  for (const id of ['first', 'second']) {
    const call = request(id);
    const reply = await bridge.rpc(call, { reservationId: `local-${id}` });
    assert.deepEqual(reply.result, call);
    const rows = records().filter(r => r.reservationId === `local-${id}`);
    assert.deepEqual(rows.map(r => r.kind), ['request', 'dispatch', 'response', 'settled']);
    assert.ok(rows.slice(1).every(r => r.requestSequence === rows[0].sequence));
  }
  await assert.rejects(bridge.rpc(request('third'), { reservationId: 'local-first' }), /Reservation id already used/);
  assert.equal(records().filter(r => r.kind === 'dispatch').length, 2);
});

test('uncertainty and late response keep the caller reservation identity', async t => {
  const { bridge, records } = setup(t, `${reader}
    process.stderr.write('accepted'); setTimeout(()=>process.stdout.write(
      JSON.stringify({jsonrpc:'2.0',id:r.id,result:{receipt:'exact'}})+'\\n'),100); });`);
  const controller = new AbortController();
  const result = assert.rejects(bridge.rpc(request(), {
    reservationId: 'persisted-local-uuid', signal: controller.signal,
  }), error => {
    assert.equal(error.classification, 'execution_uncertain');
    assert.equal(error.record.reservationId, 'persisted-local-uuid');
    return true;
  });
  await until(() => records().some(r => r.kind === 'stderr'));
  controller.abort();
  await result;
  await until(() => records().some(r => r.kind === 'response'));
  const response = records().find(r => r.kind === 'response');
  assert.equal(response.late, true);
  assert.equal(response.reservationId, 'persisted-local-uuid');
  assert.equal(response.requestSequence, records()[0].sequence);
});
