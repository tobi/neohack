import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { createSnapshotClient } from './client.mjs';

const sessionId = 'disposable-fixture';
const frame = (revision, extra = {}) => ({ version: 1, sessionId, requestId: null, revision,
  observation: { turn: revision * 2, location: { id: 'fixture-level' }, you: { x: 2, y: 3 },
    vitals: { hp: 12 }, inventory: [], inventoryKnown: true, here: { known: true, items: [] },
    perception: { version: 1, inventory: 'current', here: 'current', equipment: 'current' },
    world: [], heard: [] },
  outcome: { action: 'fixture', status: 'completed', turnsElapsed: 0, positionChanged: false, effects: [] },
  events: [], decision: null, ended: false, end: null, ...extra });
const mcp = value => ({ jsonrpc: '2.0', id: 1, result: { structuredContent: value } });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function setup(t, options = {}) {
  const runDir = await mkdtemp(join(tmpdir(), 'neohack-client-'));
  t.after(() => rm(runDir, { recursive: true, force: true }));
  const client = createSnapshotClient({ runDir, sessionId, send: async () => frame(1), ...options });
  return { runDir, client };
}
const stateFile = runDir => readFile(join(runDir, 'state.json'), 'utf8').then(JSON.parse);
async function receipts(runDir) {
  return Promise.all((await readdir(join(runDir, 'receipts')))
    .filter(name => name.endsWith('.json')).map(name => readFile(join(runDir, 'receipts', name), 'utf8').then(JSON.parse)));
}

test('call and play replace the same authoritative snapshot and preserve explicit decisions', async t => {
  let next = 0;
  const calls = [];
  const { client, runDir } = await setup(t, { send: async call => {
    calls.push(call);
    return mcp(frame(++next, next === 2 ? { decision: { id: 'exact-question', kind: 'confirmation' } } : {}));
  } });
  await client.observe();
  await client.call({ name: 'attack', arguments: { direction: 'east', expectedRevision: 1 } });
  assert.equal((await client.readSnapshot()).snapshot.decision.id, 'exact-question');
  await client.play('answer', { decisionId: 'exact-question', answer: true });
  const current = await client.readSnapshot();
  assert.equal(current.revision, 3);
  assert.equal(current.snapshot.observation.turn, 6);
  assert.equal(calls[1].arguments.expectedRevision, undefined);
  assert.equal(calls[2].arguments.decisionId, 'exact-question');
  assert.ok(calls.every(call => call.arguments.sessionId === sessionId));
  assert.equal((await receipts(runDir)).length, 3);
});

test('queue serializes delayed replies and captures intent before caller mutation', async t => {
  const started = deferred(), release = deferred();
  let count = 0;
  const seen = [];
  const { client } = await setup(t, { send: async (call, context) => {
    seen.push([call, context.snapshot?.revision]);
    count++;
    if (count === 2) { started.resolve(); await release.promise; }
    return frame(count);
  } });
  await client.observe();
  const first = client.play('attack', { direction: 'east' });
  await started.promise;
  const args = { direction: 'west' };
  const second = client.call({ name: 'attack', arguments: args });
  args.direction = 'north';
  assert.equal(seen.length, 2);
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(seen[2][0].arguments.direction, 'west');
  assert.equal(seen[2][1], 2);
  assert.equal((await client.readSnapshot()).revision, 3);
});

test('preflight is awaited inside exclusive ownership; blocking guards send nothing', async t => {
  let sent = 0;
  const entered = deferred(), release = deferred();
  const { client, runDir } = await setup(t, { send: async () => frame(++sent) });
  await client.observe();
  const before = await readFile(join(runDir, 'state.json'), 'utf8');
  const action = client.execute({ name: 'attack', arguments: {} }, { preflight: async (current, call) => {
    assert.equal(current.status, 'current');
    assert.ok(Object.isFrozen(current.snapshot.observation));
    assert.ok(Object.isFrozen(call.arguments));
    entered.resolve();
    await release.promise;
    throw new Error('BLOCK');
  } });
  await entered.promise;
  const competitor = createSnapshotClient({ runDir, sessionId, send: async () => { throw Error('must not send'); } });
  await assert.rejects(competitor.observe(), { code: 'RUN_BUSY' });
  assert.equal(await readFile(join(runDir, 'state.json'), 'utf8'), before);
  release.resolve();
  await assert.rejects(action, /BLOCK/);
  assert.equal(sent, 1);
  assert.equal((await client.readSnapshot()).revision, 1);
});

test('configured preflight covers both formats, and stale revision fails before dispatch', async t => {
  let checked = 0, sent = 0;
  const { client } = await setup(t, { send: async () => frame(++sent),
    preflight: () => { checked++; throw Error('BLOCK'); } });
  await client.observe();
  await assert.rejects(client.call({ name: 'attack', arguments: {} }), /BLOCK/);
  await assert.rejects(client.play('attack'), /BLOCK/);
  await assert.rejects(client.play('attack', { expectedRevision: 0 }), { code: 'STALE_REVISION' });
  assert.equal(checked, 2);
  assert.equal(sent, 1);
});

test('request, persisted state, and response session identities cannot be substituted', async t => {
  let next = frame(4), sent = 0;
  const { client, runDir } = await setup(t, { send: async () => { sent++; return next; } });
  await client.observe();
  assert.throws(() => client.play('attack', { sessionId: 'other' }), { code: 'WRONG_SESSION' });
  const other = createSnapshotClient({ runDir, sessionId: 'other', send: async () => { sent++; } });
  await assert.rejects(other.observe(), { code: 'WRONG_SESSION' });
  next = frame(5, { sessionId: 'other' });
  await assert.rejects(client.call({ name: 'attack' }), { code: 'WRONG_SESSION' });
  const state = await client.readSnapshot({ requireCurrent: false });
  assert.equal(state.snapshot.sessionId, sessionId);
  assert.equal(state.revision, 4);
  assert.equal(state.status, 'uncertain');
  await assert.rejects(client.readSnapshot(), { code: 'STALE_SNAPSHOT' });
  assert.equal(sent, 2);
  assert.equal((await receipts(runDir)).length, 2);
});

test('older and explicitly historical receipts never become current snapshots', async t => {
  let next = frame(10);
  const { client, runDir } = await setup(t, { send: async () => next });
  await client.observe();
  next = frame(3);
  const old = await client.play('attack');
  assert.equal(old.response.revision, 3);
  assert.equal(old.state.revision, 10);
  assert.equal(old.state.snapshot.revision, 10);
  assert.equal(old.state.status, 'needs-observation');
  await assert.rejects(client.play('attack'), { code: 'STALE_SNAPSHOT' });
  next = frame(11);
  await client.observe();
  next = frame(12, { historical: true });
  const historical = await client.play('receipt', { operationId: 'old-operation' });
  assert.equal(historical.state.snapshot.revision, 11);
  assert.equal(historical.state.revision, 12);
  assert.equal(historical.state.status, 'needs-observation');
  next = frame(11);
  await client.observe();
  await assert.rejects(client.readSnapshot(), { code: 'STALE_SNAPSHOT' });
  assert.deepEqual((await receipts(runDir)).map(row => row.raw.revision).sort((a, b) => a - b), [3, 10, 11, 11, 12]);
});

test('a public query without observation explicitly invalidates preflight until observe', async t => {
  let next = frame(2);
  const { client } = await setup(t, { send: async () => next });
  await client.observe();
  next = { version: 1, sessionId, kind: 'lore', name: 'door', found: false, lines: [] };
  assert.equal((await client.play('lookup')).state.status, 'needs-observation');
  await assert.rejects(client.readSnapshot(), { code: 'STALE_SNAPSHOT' });
  next = frame(2);
  await client.observe();
  assert.equal((await client.readSnapshot()).status, 'current');
});

for (const [label, bad, code, status] of [
  ['JSON-RPC error', { jsonrpc: '2.0', id: 1, error: { code: -1, message: 'failed' } }, 'REPLY_ERROR', 'error'],
  ['MCP error with apparently valid content', { result: { isError: true, structuredContent: frame(8) } }, 'REPLY_ERROR', 'error'],
  ['semantic error', frame(8, { error: { code: 'incompleteRequest', message: 'unknown' } }), 'REPLY_ERROR', 'error'],
  ['unknown execution', frame(8, { outcome: { status: 'unknown' } }), 'UNCERTAIN_REPLY', 'uncertain'],
  ['storage failure', frame(8, { storage: { status: 'failed' } }), 'UNCERTAIN_REPLY', 'uncertain'],
  ['top recovery gate', frame(8, { inputGate: { state: 'recoveryRequired' } }), 'RECOVERY_REQUIRED', 'uncertain'],
  ['unavailable gate', frame(8, { inputGate: { state: 'unavailable' } }), 'UNCERTAIN_REPLY', 'uncertain'],
  ['neighborhood recovery gate', frame(8, { observation: { ...frame(8).observation,
    neighborhood: { status: 'available', inputGate: { state: 'recoveryRequired' } } } }), 'RECOVERY_REQUIRED', 'uncertain'],
  ['unresolved compact delta', frame(8, { update: { kind: 'delta', id: 2, base: 1 } }), 'UNRESOLVED_DELTA', 'uncertain'],
  ['missing observation turn', frame(8, { observation: {} }), 'INVALID_REPLY', 'uncertain'],
  ['malformed reply', { sessionId }, 'INVALID_REPLY', 'uncertain'],
  ['unknown response version', frame(8, { version: 2 }), 'INVALID_REPLY', 'uncertain'],
]) {
  test(`${label} cannot authorize stale preflight or fresh input`, async t => {
    let next = frame(7), sent = 0;
    const { client, runDir } = await setup(t, { send: async () => { sent++; return next; } });
    await client.observe();
    next = bad;
    await assert.rejects(client.play('attack'), { code });
    const state = await client.readSnapshot({ requireCurrent: false });
    assert.equal(state.status, status);
    assert.equal(state.snapshot.revision, 7);
    assert.equal(state.pendingRequest.name, 'attack');
    await assert.rejects(client.observe(), { code: 'RECOVERY_REQUIRED' });
    await assert.rejects(client.play('wait'), { code: 'RECOVERY_REQUIRED' });
    assert.equal(sent, 2);
    assert.equal((await receipts(runDir)).length, 2);
  });
}

test('exact recovery archives the old receipt then observes; lost input is never resent', async t => {
  const calls = [];
  let recoveredCall, sentId, recoveredId;
  const { client, runDir } = await setup(t, {
    send: async (call, context) => {
      calls.push(call);
      if (call.name === 'attack') { sentId = context.reservationId; throw Error('lost reply'); }
      return frame(calls.length === 1 ? 10 : 12);
    },
    recoverExact: async (call, context) => {
      recoveredCall = call; recoveredId = context.reservationId;
      return frame(4, { historical: true });
    },
  });
  await client.observe();
  await assert.rejects(client.play('attack', { direction: 'east' }), /lost reply/);
  const pending = (await stateFile(runDir)).pendingRequest;
  await assert.rejects(client.observe(), { code: 'RECOVERY_REQUIRED' });
  const recovered = await client.recover();
  assert.deepEqual(recoveredCall, pending);
  assert.equal(recoveredId, sentId);
  assert.equal(typeof sentId, 'string');
  assert.equal(recovered.recovered.state.snapshot.revision, 10);
  assert.equal(recovered.state.snapshot.revision, 12);
  assert.equal(recovered.state.pendingRequest, null);
  assert.deepEqual(calls.map(call => call.name), ["observe", 'attack', "observe"]);
  assert.equal((await receipts(runDir)).filter(row => row.kind === 'recovery').length, 1);
});

test('an explicit runtime resume requirement cannot be cleared by an observe', async t => {
  let sent = 0;
  const { client } = await setup(t, { send: async () => {
    sent++; return frame(1, { diagnostics: { requiresResume: true } });
  } });
  await assert.rejects(client.observe(), { code: 'RESUME_REQUIRED' });
  await assert.rejects(client.observe(), { code: 'RESUME_REQUIRED' });
  await assert.rejects(client.play('attack'), { code: 'RESUME_REQUIRED' });
  await assert.rejects(client.recover(), { code: 'RESUME_REQUIRED' });
  assert.equal(sent, 1);
});

test('a recovery-required observe cannot be cleared by another free observe', async t => {
  let sent = 0;
  const { client } = await setup(t, { send: async () => {
    sent++; return frame(1, { inputGate: { state: 'recoveryRequired' } });
  } });
  await assert.rejects(client.observe(), { code: 'RECOVERY_REQUIRED' });
  await assert.rejects(client.observe(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(sent, 1);
});

for (const kind of ['death', 'ascended', 'escaped', 'quit', 'disconnected']) {
  test(`${kind} snapshot cannot become live through a newer same-session response`, async t => {
    let next = frame(4, { ended: true, end: { kind, turn: 8 } });
    const { client } = await setup(t, { send: async () => next });
    await client.observe();
    await assert.rejects(client.play('attack'), { code: 'TERMINAL_STATE' });
    next = frame(5);
    await assert.rejects(client.observe(), {
      code: kind === 'disconnected' ? 'RESUME_REQUIRED' : 'TERMINAL_REGRESSION',
    });
    const stored = await client.readSnapshot({ requireCurrent: false });
    assert.equal(stored.snapshot.ended, true);
    assert.equal(stored.snapshot.end.kind, kind);
    assert.equal(stored.revision, 4);
  });
}

test('persistence failure after rename retains ownership even if a current file is visible', async t => {
  let inject = false;
  const { client, runDir } = await setup(t, {
    checkpoint: ({ phase, value, path }) => {
      if (inject && phase === 'committed' && path.endsWith('/state.json') && value.status === 'current')
        throw Error('simulated durability failure');
    },
  });
  await client.observe();
  inject = true;
  await assert.rejects(client.play('attack'), /simulated durability failure/);
  assert.equal((await stateFile(runDir)).status, 'current');
  await assert.rejects(client.readSnapshot(), { code: 'RUN_BUSY' });
});

test('missing exact recovery and failed post-recovery observation remain closed', async t => {
  let observed = 0;
  const { client, runDir } = await setup(t, {
    send: async call => {
      if (call.name !== "observe") throw Error('lost input');
      if (++observed > 1) throw Error('lost observation');
      return frame(3);
    }, recoverExact: async () => frame(4),
  });
  await client.observe();
  await assert.rejects(client.play('attack'), /lost input/);
  const noRecovery = createSnapshotClient({ runDir, sessionId, send: async () => frame(9) });
  await assert.rejects(noRecovery.recover(), { code: 'RECOVERY_UNAVAILABLE' });
  await assert.rejects(client.recover(), /lost observation/);
  await assert.rejects(client.play('wait'), { code: 'STALE_SNAPSHOT' });
  assert.equal((await client.readSnapshot({ requireCurrent: false })).pendingKind, 'observe');
  // A free observation may be repeated only after the input was exactly settled.
  await noRecovery.observe();
  assert.equal((await noRecovery.readSnapshot()).revision, 9);
});

test('injected public decoder receives raw replies without a second perception reducer', async t => {
  const raw = { result: { structuredContent: { update: { kind: 'delta' } } } };
  const { client } = await setup(t, { send: async () => raw,
    decodeReply: reply => { assert.deepEqual(reply, raw); return frame(2); } });
  assert.equal((await client.observe()).state.revision, 2);
});

test('corrupt persisted state is not silently truncated or overwritten', async t => {
  const { client, runDir } = await setup(t);
  await client.observe();
  await writeFile(join(runDir, 'state.json'), '{broken');
  await assert.rejects(client.observe(), SyntaxError);
  assert.equal(await readFile(join(runDir, 'state.json'), 'utf8'), '{broken');
});

async function child(t, runDir, script) {
  const path = join(runDir, `child-${Math.random()}.mjs`);
  await writeFile(path, `import {createSnapshotClient} from ${JSON.stringify(new URL('./client.mjs', import.meta.url).href)};\n${script}`);
  const process = fork(path, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => { if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL'); });
  return process;
}

test('another process cannot dispatch while a delayed reply owns the run', async t => {
  const { client, runDir } = await setup(t);
  await client.observe();
  const worker = await child(t, runDir, `
    const client=createSnapshotClient({runDir:${JSON.stringify(runDir)},sessionId:${JSON.stringify(sessionId)},
      send:async()=>{process.send('entered');await new Promise(resolve=>process.once('message',resolve));return ${JSON.stringify(frame(2))};}});
    await client.play('attack');process.send('finished');process.disconnect();
  `);
  assert.equal((await once(worker, 'message', { signal: AbortSignal.timeout(5000) }))[0], 'entered');
  await assert.rejects(client.play('wait'), { code: 'RUN_BUSY' });
  assert.equal((await stateFile(runDir)).status, 'uncertain');
  const exited = once(worker, 'exit');
  worker.send('release');
  assert.equal((await exited)[0], 0);
  assert.equal((await client.readSnapshot()).revision, 2);
});

test('process death during snapshot write preserves complete uncertain state and separate receipt', async t => {
  const { client, runDir } = await setup(t);
  await client.observe();
  const worker = await child(t, runDir, `
    const client=createSnapshotClient({runDir:${JSON.stringify(runDir)},sessionId:${JSON.stringify(sessionId)},
      send:async()=>(${JSON.stringify(frame(2))}),
      checkpoint:async({phase,path,value})=>{if(phase==='temporary-synced'&&path.endsWith('/state.json')&&value.status==='current'){
        process.send('snapshot-write');await new Promise(resolve=>process.once('message',resolve));}}});
    await client.play('attack');
  `);
  assert.equal((await once(worker, 'message', { signal: AbortSignal.timeout(5000) }))[0], 'snapshot-write');
  const exited = once(worker, 'exit');
  worker.kill('SIGKILL');
  assert.equal((await exited)[1], 'SIGKILL');
  const state = await stateFile(runDir);
  assert.equal(state.status, 'uncertain');
  assert.equal(state.revision, 1);
  assert.equal(state.pendingRequest.name, 'attack');
  assert.equal((await receipts(runDir)).length, 2);
  await assert.rejects(client.observe(), { code: 'RUN_BUSY' });
  // Fixture-only operator recovery: child exit was awaited, so ownership ended.
  await rmdir(join(runDir, '.client-owner'));
  await assert.rejects(client.observe(), { code: 'RECOVERY_REQUIRED' });
  const resumed = createSnapshotClient({ runDir, sessionId,
    recoverExact: async () => frame(2, { historical: true }), send: async () => frame(2) });
  await resumed.recover();
  assert.equal((await resumed.readSnapshot()).revision, 2);
});

// Opt in after building native, without adding a runtime/dependency requirement
// to the fixture suite: NEONETHACK_MCP_TEST_ROOT=$PWD/lib/neonethack node --test ...
if (process.env.NEONETHACK_MCP_TEST_ROOT) {
  test('native MCP: mixed formats, real decision, old receipt and exact recovery', { timeout: 30000 }, async t => {
    const root = process.env.NEONETHACK_MCP_TEST_ROOT;
    const runDir = await mkdtemp(join(tmpdir(), 'neohack-client-native-'));
    const runtime = spawn(join(root, 'build/native/neonethack-mcp'), [
      join(root, 'engine/playground/nethack'), join(root, 'engine/playground'), join(runDir, 'sessions'),
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = once(runtime, 'exit');
    let stderr = '';
    runtime.stderr.on('data', bytes => { stderr += bytes; });
    const lines = createInterface({ input: runtime.stdout })[Symbol.asyncIterator]();
    t.after(async () => { runtime.stdin.end(); await closed; await rm(runDir, { recursive: true, force: true }); });
    let sequence = 0;
    async function rpc(method, params) {
      runtime.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params })}\n`);
      const next = await lines.next();
      assert.equal(next.done, false, stderr);
      const response = JSON.parse(next.value);
      assert.equal(response.id, sequence);
      assert.equal(response.error, undefined, JSON.stringify(response));
      return response;
    }
    await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {},
      clientInfo: { name: 'snapshot-test', version: '1' } });
    runtime.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const created = (await rpc('tools/call', { name: "create", arguments: {
      name: 'SnapshotTest', seed: 42, role: 'valkyrie', race: 'dwarf', gender: 'female', align: 'lawful',
    } })).result.structuredContent;
    let loseReply = false;
    const reservations = new Map();
    const client = createSnapshotClient({ runDir: join(runDir, 'client'), sessionId: created.sessionId,
      send: async (call, context) => {
        const reply = await rpc('tools/call', call);
        reservations.set(context.reservationId, reply.result.structuredContent.operationId);
        if (loseReply) { loseReply = false; throw Error('fixture lost committed reply'); }
        return reply;
      },
      recoverExact: async (call, context) => {
        assert.equal(call.name, "wait");
        const operationId = reservations.get(context.reservationId);
        assert.equal(typeof operationId, 'string');
        return rpc('tools/call', { name: 'receipt', arguments: { sessionId: created.sessionId, operationId } });
      },
    });
    const initial = (await client.observe()).state;
    const waited = await client.call({ name: "wait", arguments: {} });
    assert.equal(waited.state.snapshot.observation.turn, initial.snapshot.observation.turn + 1);
    const eating = await client.play("eat");
    assert.equal(eating.state.snapshot.decision.kind, 'item');
    const cancelled = await client.call({ name: "cancel", arguments: {
      decisionId: eating.state.snapshot.decision.id,
    } });
    assert.equal(cancelled.state.snapshot.decision, null);
    const historical = await client.play('receipt', { operationId: waited.response.operationId });
    assert.equal(historical.state.status, 'needs-observation');
    assert.equal(historical.state.snapshot.revision, cancelled.state.revision);
    await client.observe();
    loseReply = true;
    await assert.rejects(client.play("wait"), /fixture lost committed reply/);
    await assert.rejects(client.observe(), { code: 'RECOVERY_REQUIRED' });
    const recovered = await client.recover();
    assert.equal(recovered.state.status, 'current');
    assert.equal(recovered.state.snapshot.observation.turn, waited.state.snapshot.observation.turn + 1);
  });
}
