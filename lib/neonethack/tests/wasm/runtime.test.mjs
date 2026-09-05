import { doorOrientationContracts } from '../door-orientation-contracts.mjs';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { readFile, cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import { WasmTransport, createWasm } from '../../dist/typescript/wasm.js';
import { Neonethack } from '../../dist/typescript/client.js';
import { affordanceContracts, doorContracts } from '../affordance-contracts.mjs';
import { gameplayContracts } from '../gameplay-contracts.mjs';
import { interruptionContracts } from '../interruption-contracts.mjs';
import { decisionContracts } from '../decision-contracts.mjs';
const root = resolve(import.meta.dirname, '../..');
const schema = JSON.parse(await readFile(`${root}/protocol/response.schema.json`, 'utf8'));
const validate = new Ajv({ strict: false }).compile(schema);
const identity = { name: 'Wasm', seed: 42, role: 'valkyrie', race: 'dwarf', gender: 'female', align: 'lawful' };
async function fixture(t) {
  const transport = await WasmTransport.create();
  t.after(() => transport.close());
  const send = transport.send.bind(transport);
  transport.send = async request => {
    const response = await send(request);
    assert.ok(validate(response), JSON.stringify(validate.errors));
    return response;
  };
  return { transport, api: new Neonethack(transport) };
}
const restartable = async t => {
  const backend = await fixture(t);
  backend.restart = async game => { await game.close(); return backend.api.resume(game.id); };
  return backend;
};
affordanceContracts('WASM', restartable);
doorContracts('WASM', restartable);
gameplayContracts('WASM', restartable);
interruptionContracts('WASM', restartable);
decisionContracts('WASM', restartable);
test('WASM runtime profile survives changed clock and host time zone', async t => {
  const directory = await mkdtemp(`${tmpdir()}/neonethack-clock-`);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = `${directory}/clock`;
  await writeFile(clock, String(Date.parse('2000-10-13T23:30:00Z') / 1000));
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', `${import.meta.dirname}/clock-preload.mjs`, `${import.meta.dirname}/clock-scenario.mjs`], {
    env: { ...process.env, NNH_TEST_CLOCK: clock, TZ: 'Pacific/Auckland' }, timeout: 30_000,
  });
  assert.match(stdout, /calendar profile and changed-clock continuation passed/);
});
test('WASM runs the semantic C API, with exact retries and pending resume', { timeout: 30_000 }, async t => {
  const { api, transport } = await fixture(t);
  const description = await api.describe();
  assert.equal(description.backend, 'wasm');
  assert.deepEqual(description.capabilities, { persistence: 'memory', durability: 'none', ownership: 'isolated-worker', resume: 'same-package', runtimeProfile: 1, affordanceVersion: 1 });
  const game = await api.create(identity);
  const request = { version: 1, method: 'game.wait', params: { sessionId: game.id, requestId: 'wait-once', expectedRevision: game.state.revision } };
  const one = await transport.send(request);
  assert.equal(one.observation.turn, game.observation.turn + 1);
  assert.deepEqual(await transport.send(request), one);
  await game.observe();
  const food = await game.eat();
  assert.equal(food.decision.kind, 'item');
  assert.equal(food.outcome.turnsElapsed, 0);
  assert.ok(food.decision.options.every(item => typeof item.id === 'string'));
  await game.cancel(food.decision.id);
  const prayer = await game.pray();
  assert.equal(prayer.decision.kind, 'confirmation');
  await game.close();
  const resumed = await api.resume(game.id);
  assert.deepEqual(resumed.observation, prayer.observation);
  assert.deepEqual(resumed.decision, prayer.decision);
  const declined = await resumed.answer(resumed.decision.id, { kind: 'confirmation', confirm: false });
  assert.equal(declined.decision, null);
  assert.equal(declined.observation.turn, prayer.observation.turn);
});
test('WASM sessions are isolated and invalid parameters send no action', { timeout: 30_000 }, async t => {
  const { api, transport } = await fixture(t);
  const a = await api.create(identity), b = await api.create({ ...identity, name: 'Second' });
  const before = b.observation;
  await a.wait(); await a.close();
  assert.deepEqual((await b.observe()).observation, before);
  const rejected = await transport.send({ version: 1, method: 'game.wait', params: { sessionId: b.id, requestId: 'bad', expectedRevision: b.state.revision, direction: 'north' } });
  assert.equal(rejected.error.code, 'invalidParams');
  assert.deepEqual((await b.observe()).observation, before);
  assert.equal((await b.wait()).observation.turn, before.turn + 1);
});
test('Node never silently substitutes memory for requested browser durability', async () => {
  await assert.rejects(createWasm({ storage: { kind: 'indexeddb', name: 'not-in-node' } }), /requires IndexedDB and Web Locks/);
});
test('a damaged WASM artifact is rejected before a world can start', async t => {
  const temporary = await mkdtemp(`${tmpdir()}/nnh-wasm-integrity-`);
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await cp(`${root}/dist/wasm`, temporary, { recursive: true });
  const path = `${temporary}/neonethack-core.wasm`;
  const bytes = await readFile(path); bytes[bytes.length - 1] ^= 1; await writeFile(path, bytes);
  await assert.rejects(createWasm({ workerUrl: pathToFileURL(`${temporary}/core-worker.mjs`) }), /integrity mismatch/);
});

doorOrientationContracts('WASM', restartable);
