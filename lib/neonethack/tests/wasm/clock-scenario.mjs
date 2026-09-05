import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createWasm } from '../../dist/typescript/wasm.js';
const api = await createWasm();
const identity = { name: 'Calendar', seed: 42, role: 'valkyrie', race: 'dwarf', gender: 'female', align: 'lawful' };
try {
  assert.equal((await api.describe()).capabilities.runtimeProfile, 1);
  const first = await api.create(identity), twin = await api.create(identity);
  assert.ok(first.observation.heard.some(s => s.includes('Friday the 13th')), 'Use Friday UTC, not Saturday in Pacific/Auckland');
  assert.deepEqual(first.observation, twin.observation);
  const pending = await first.pray(); await twin.pray();
  await first.close();
  await writeFile(process.env.NNH_TEST_CLOCK, String(Date.parse('2099-12-31T23:59:59Z') / 1000));
  const restored = await api.resume(first.id);
  assert.deepEqual(restored.observation, pending.observation); assert.deepEqual(restored.decision, pending.decision);
  await restored.cancel(restored.decision.id); await twin.cancel(twin.decision.id);
  for (let i = 0; i < 3; ++i) assert.deepEqual((await restored.wait()).observation, (await twin.wait()).observation);
  const future = await api.create(identity);
  assert.ok(!future.observation.heard.some(s => s.includes('Friday the 13th')), 'Control clock must actually change for new worlds');
} finally { await api.close(); }
console.log('WASM calendar profile and changed-clock continuation passed');
