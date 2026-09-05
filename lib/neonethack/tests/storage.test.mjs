import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, copyFile, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fixture, root, identity } from './native-fixture.mjs';

test('new worlds copy only static data and resume pins data independently of rebuilds', async t => {
  const data = await mkdtemp(`${tmpdir()}/neonethack-template-`);
  t.after(() => rm(data, { recursive: true, force: true }));
  for (const file of ['nhdat', 'sysconf', 'symbols', 'license']) await copyFile(`${root}/engine/playground/${file}`, `${data}/${file}`);
  await mkdir(`${data}/save`);
  await writeFile(`${data}/save/another-player`, 'private saved world');
  await writeFile(`${data}/bones-secret`, 'must not enter another world');
  await writeFile(`${data}/logfile`, 'private narration');
  const { api, sessions } = await fixture(t, { dataPath: data });
  const game = await api.create(identity);
  const names = await readdir(`${sessions}/${game.id}/playground`);
  assert.ok(!names.includes('bones-secret'));
  assert.deepEqual(await readdir(`${sessions}/${game.id}/playground/save`), []);
  assert.ok(!(await readFile(`${sessions}/${game.id}/playground/logfile`, 'utf8')).includes('private narration'));
  const state = await game.wait();
  await game.close();
  const pinned = await readFile(`${sessions}/${game.id}/data/nhdat`);
  await writeFile(`${data}/nhdat`, 'a different broken archive');
  await writeFile(`${data}/sysconf`, 'INVALID_CONFIGURATION=1\n');
  const resumed = await api.resume(game.id);
  assert.deepEqual(resumed.observation, state.observation);
  assert.deepEqual(await readFile(`${sessions}/${game.id}/data/nhdat`), pinned);
});

test('exclusive native lease prevents a second owner until close', async t => {
  const first = await fixture(t);
  const second = await fixture(t, { sessions: first.sessions });
  const game = await first.api.create(identity);
  const busy = await second.api.request('session.resume', { sessionId: game.id });
  assert.equal(busy.error.code, 'sessionBusy');
  const before = await game.observe();
  await game.close();
  const resumed = await second.api.resume(game.id);
  assert.deepEqual(resumed.observation, before.observation);
  await resumed.close();
});

test('old durable receipts survive hot-cache eviction and cold resume', { timeout: 30_000 }, async t => {
  const { api, transport, sessions } = await fixture(t);
  const game = await api.create(identity);
  const request = { version: 1, method: 'game.wait', params: { sessionId: game.id, requestId: 'old-receipt', expectedRevision: game.state.revision } };
  const receipt = await transport.send(request);
  await game.observe();
  for (let i = 0; i < 36; i++) { const offer = await game.eat(); await game.cancel(offer.decision.id); }
  const current = game.state;
  await transport.close();
  const cold = await fixture(t, { sessions });
  const resumed = await cold.api.resume(game.id);
  assert.deepEqual(await cold.transport.send(request), receipt);
  assert.deepEqual((await resumed.observe()).observation, current.observation);
  const conflict = await cold.transport.send({ ...request, method: 'game.move', params: { ...request.params, direction: 'north' } });
  assert.ok(conflict.error);
  assert.deepEqual((await resumed.observe()).observation, current.observation);
});

test('torn native input is preserved and refuses resume', async t => {
  const { api, sessions } = await fixture(t);
  const game = await api.create(identity);
  await game.wait(); await game.close();
  const path = `${sessions}/${game.id}/input.log.jsonl`;
  const damaged = Buffer.concat([await readFile(path), Buffer.from('{')]);
  await writeFile(path, damaged);
  const result = await api.request('session.resume', { sessionId: game.id });
  assert.equal(result.error.code, 'inputHistoryError');
  assert.deepEqual(await readFile(path), damaged);
});
