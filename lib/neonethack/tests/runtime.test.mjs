import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fixture, identity, root } from './native-fixture.mjs';
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
const friday = Date.parse('2000-10-13T23:30:00Z') / 1000;
const later = Date.parse('2099-12-31T23:59:59Z') / 1000;
async function setup(t) {
  const work = await mkdtemp(`${tmpdir()}/neonethack-runtime-`);
  await writeFile(`${work}/clock`, String(friday));
  await mkdir(`${work}/home`);
  await writeFile(`${work}/home/.nethackrc`, 'OPTIONS=pettype:none,name:Changed,number_pad:1,tutorial\nBINDINGS=j:jump\n');
  const make = async (tag, options) => {
    const executable = `${work}/${tag}`;
    const cli = process.env.NEONETHACK_EXECUTABLE ?? `${root}/build/native/neonethack`;
    const module = process.env.NNH_FAULT_MODULE ?? `${root}/build/native/libneonethack-fault.so`;
    await writeFile(executable, `#!/bin/sh\nexec env LD_PRELOAD=${quote(module)} NNH_TEST_CLOCK=${quote(`${work}/clock`)} HOME=${quote(`${work}/home`)} USER=Changed LOGNAME=Changed TZ=Pacific/Honolulu NETHACKOPTIONS=${quote(options)} ${quote(cli)} "$@"\n`, { mode: 0o700 });
    return executable;
  };
  // Register final directory cleanup after fixture's transport cleanup.
  return { work, make, cleanup: () => t.after(() => rm(work, { recursive: true, force: true })) };
}
test('profile 1 fixes UTC calendar, isolates user options/RC, and survives changed-clock/options cold replay', { skip: process.platform !== 'linux' }, async t => {
  const setup_ = await setup(t), { work, make } = setup_;
  const a = await fixture(t, { executable: await make('a', '!tutorial,time') }); setup_.cleanup();
  assert.equal((await a.api.describe()).capabilities.runtimeProfile, 1);
  const game = await a.api.create(identity);
  assert.ok(game.observation.heard.some(s => s.includes('Friday the 13th')), 'Engine must use recorded UTC calendar, not its actual OS date');
  assert.ok(game.observation.world.some(c => c.occupant?.kind === 'ally'), 'User RC must not remove the pet');
  const birth = game.observation;
  const path = `${a.sessions}/${game.id}/input.log.jsonl`;
  const initial = JSON.parse((await readFile(path, 'utf8')).split('\n')[0]);
  assert.deepEqual(initial.params, { protocolVersion: '0.1', runtimeProfile: 1, calendarEpoch: friday });
  const pending = await game.pray(); assert.equal(pending.decision.kind, 'confirmation');
  const before = await readFile(path);
  await a.transport.close(); await writeFile(`${work}/clock`, String(later));
  const b = await fixture(t, { sessions: a.sessions, executable: await make('b', 'pettype:none,number_pad:1,name:Different,tutorial') });
  const restored = await b.api.resume(game.id);
  assert.deepEqual(restored.observation, pending.observation); assert.deepEqual(restored.decision, pending.decision);
  assert.deepEqual(await readFile(path), before);
  await restored.cancel(restored.decision.id);
  // Options-as-filename is also ignored during creation; explicit public
  // identity and the profile, not user configuration, determine the world.
  await writeFile(`${work}/clock`, String(friday));
  const c = await fixture(t, { executable: await make('c', `@${work}/home/.nethackrc`) });
  const fresh = await c.api.create(identity); assert.deepEqual(fresh.observation, birth);
  await fresh.pray(); await fresh.cancel(fresh.decision.id);
  await writeFile(`${work}/clock`, String(later));
  for (let i = 0; i < 3; ++i)
    assert.deepEqual((await restored.wait()).observation, (await fresh.wait()).observation);
  const { x, y } = restored.observation.you;
  assert.ok(restored.observation.world.some(c => c.x === x && c.y === y + 1 && c.terrain.type === 'floor'));
  const moved = await restored.move('south');
  assert.deepEqual(moved.observation.you, { x, y: y + 1 }, 'Named movement must not inherit keypad/custom bindings');
  assert.deepEqual(moved.observation, (await fresh.move('south')).observation);
  const future = await b.api.create(identity);
  const futureInit = JSON.parse((await readFile(`${b.sessions}/${future.id}/input.log.jsonl`, 'utf8')).split('\n')[0]);
  assert.equal(futureInit.params.calendarEpoch, 4102444799);
  assert.ok(!future.observation.heard.some(s => s.includes('Friday the 13th')));
});
test('engine must acknowledge the exact recorded runtime before any new_game is sent', async t => {
  const work = await mkdtemp(`${tmpdir()}/neonethack-ack-`), peer = `${work}/peer`, trace = `${work}/trace`;
  await writeFile(peer, `#!${process.execPath}\nconst fs = require('node:fs');\nlet input = '';\nprocess.stdin.on('data', data => { fs.appendFileSync(${JSON.stringify(trace)}, data); input += data; const end = input.indexOf('\\n'); if (end >= 0) { const request = JSON.parse(input.slice(0, end)); input = input.slice(end + 1); console.log(JSON.stringify({ id: 1, result: { runtimeProfile: 1, calendarEpoch: request.params.calendarEpoch + 1 } })); } });\n`, { mode: 0o700 });
  const { api } = await fixture(t, { enginePath: peer });
  t.after(() => rm(work, { recursive: true, force: true }));
  const result = await api.request('session.create', identity);
  assert.equal(result.error.code, 'runtimeUnavailable');
  const input = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(input.length, 1); assert.equal(input[0].method, 'initialize');
});
async function journalBytes(directory) {
  const files = {};
  for (const name of await readdir(directory)) if (/\.jsonl?$/.test(name)) files[name] = await readFile(`${directory}/${name}`);
  return files;
}
for (const mode of ['unprofiled', 'partial', 'unknown', 'range']) {
  test(`runtime ${mode} history is refused without changing original journals or pins`, async t => {
    const { api, sessions } = await fixture(t), game = await api.create(identity);
    await game.close();
    const dir = `${sessions}/${game.id}`, path = `${dir}/input.log.jsonl`;
    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n'), init = JSON.parse(lines[0]);
    if (mode === 'unprofiled') { delete init.params.runtimeProfile; delete init.params.calendarEpoch; }
    if (mode === 'partial') delete init.params.calendarEpoch;
    if (mode === 'unknown') init.params.runtimeProfile = 2;
    if (mode === 'range') init.params.calendarEpoch = 4102444800;
    lines[0] = JSON.stringify(init); await writeFile(path, lines.join('\n') + '\n');
    const before = await journalBytes(dir), pin = await readFile(`${dir}/engine`);
    const result = await api.request('session.resume', { sessionId: game.id });
    assert.equal(result.error.code, mode === 'unprofiled' ? 'runtimeUnavailable' : 'inputHistoryError');
    assert.deepEqual(await journalBytes(dir), before); assert.deepEqual(await readFile(`${dir}/engine`), pin);
  });
}
