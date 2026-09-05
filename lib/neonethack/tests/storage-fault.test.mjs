import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fixture, identity, root } from './native-fixture.mjs';
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
async function faults(t) {
  const dir = await mkdtemp(`${tmpdir()}/neonethack-fault-`), wrapper = `${dir}/bridge`;
  const executable = process.env.NEONETHACK_EXECUTABLE ?? `${root}/build/native/neonethack`;
  const module = process.env.NNH_FAULT_MODULE ?? `${root}/build/native/libneonethack-fault.so`;
  await writeFile(wrapper, `#!/bin/sh\nprintf '%s' "$$" > ${quote(`${dir}/owner`)}\nexec env LD_PRELOAD=${quote(module)} NNH_TEST_OWNER=${quote(`${dir}/owner`)} NNH_TEST_FAULT=${quote(`${dir}/fault`)} NNH_TEST_WRITES=${quote(`${dir}/writes`)} ${quote(executable)} "$@"\n`, { mode: 0o700 });
  const backend = await fixture(t, { executable: wrapper });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { ...backend, inject: mode => writeFile(`${dir}/fault`, mode), writes: () => readFile(`${dir}/writes`) };
}
const linux = { skip: process.platform !== 'linux' };
for (const kind of ['item', 'confirmation']) for (const mode of ['sidecar', 'data']) {
  test(`storage: ${mode} failure withholds unsafe ${kind} offers until explicit recovery`, linux, async t => {
    const f = await faults(t);
    const game = await f.api.create({ ...identity, name: 'Storage', role: 'wizard', race: 'human', align: 'neutral' });
    if (mode === 'data') await f.inject(mode);
    const offer = kind === 'item' ? await game.drink('healing') : await game.pray();
    assert.equal(offer.decision.kind, kind);
    if (mode === 'data') assert.equal(offer.recording.requiresResume, true);
    const path = `${f.sessions}/${game.id}/input.log.jsonl`, before = await readFile(path), writes = await f.writes();
    if (mode === 'sidecar') await f.inject(mode);
    const request = { version: 1, method: 'decision.answer', params: { sessionId: game.id, requestId: 'blocked-answer', expectedRevision: offer.revision, decisionId: offer.decision.id, answer: { kind: 'text', text: 'wrong kind' } } };
    const result = await f.transport.send(request);
    assert.ok(result.error); assert.equal(result.decision, null);
    assert.deepEqual(await f.writes(), writes); assert.deepEqual(await readFile(path), before);
    await f.inject(''); // Restoring storage alone is NOT recovery/consent.
    const observed = await f.api.request('session.observe', { sessionId: game.id });
    assert.equal(observed.decision, null);
    assert.equal(observed.observation.neighborhood.status, 'unavailable');
    assert.equal(observed.observation.neighborhood.reason, 'recoveryRequired');
    const actions=await f.api.request('session.actions',{sessionId:game.id,expectedRevision:observed.revision,target:'here'});
    assert.equal(actions.error.code,'recoveryRequired');
    assert.deepEqual(await f.writes(), writes); assert.deepEqual(await readFile(path), before);
    await f.transport.close();
    const cold = await fixture(t, { sessions: f.sessions });
    const restored = await cold.api.resume(game.id);
    assert.deepEqual(restored.decision, offer.decision); assert.deepEqual(await readFile(path), before);
    await restored.cancel(restored.decision.id);
    assert.equal(restored.decision, null);
  });
}
test('storage: failed post-input semantic checkpoint never invents consent on cold recovery', linux, async t => {
  const f = await faults(t), game = await f.api.create(identity);
  const request = { version: 1, method: 'game.pray', params: { sessionId: game.id, requestId: 'prayer', expectedRevision: game.state.revision } };
  await f.inject('boundary');
  const result = await f.transport.send(request);
  assert.ok(result.error || result.recording, JSON.stringify(result));
  const log = `${f.sessions}/${game.id}/input.log.jsonl`, before = await readFile(log);
  await f.inject(''); await f.transport.close();
  const cold = await fixture(t, { sessions: f.sessions });
  const resumed = await cold.api.request('session.resume', { sessionId: game.id });
  // A recovered standing warning is acceptable; uncertainty must instead
  // block. Neither may supply an answer that the caller never provided.
  assert.ok(resumed.error || resumed.decision?.kind === 'confirmation', JSON.stringify(resumed));
  assert.deepEqual(await readFile(log), before);
  const retry = await cold.transport.send(request);
  assert.ok(retry.error || retry.decision?.kind === 'confirmation', JSON.stringify(retry));
  assert.deepEqual(await readFile(log), before);
});
for (const mode of ['reservation', 'sidecar', 'input']) {
  test(`storage: ${mode} fsync failure prevents engine input; recovery respects the reservation boundary`, linux, async t => {
    const f = await faults(t), game = await f.api.create(identity);
    const before = await f.writes();
    const request = { version: 1, method: 'game.wait', params: { sessionId: game.id, requestId: 'uncertain', expectedRevision: game.state.revision } };
    await f.inject(mode);
    const result = await f.transport.send(request); assert.ok(result.error, JSON.stringify(result));
    assert.deepEqual(await f.writes(), before);
    await f.inject(''); // restore storage only, never modify a world journal
    const retry = await f.transport.send(request); assert.ok(retry.error, JSON.stringify(retry));
    assert.deepEqual(await f.writes(), before);
    await f.transport.close();
    const cold = await fixture(t, { sessions: f.sessions });
    await cold.api.request('session.resume', { sessionId: game.id });
    const again = await cold.transport.send(request);
    if (mode === 'sidecar') {
      // Rejection preceded even request reservation. Explicit caller recovery
      // may execute it for the first time; this is not an automatic retry.
      assert.equal(result.error.code, 'metadataUnavailable');
      assert.equal(again.error, undefined); assert.equal(again.outcome.turnsElapsed, 1);
      assert.deepEqual(await cold.transport.send(request), again);
    } else {
      assert.ok(again.error, JSON.stringify(again));
      assert.notEqual(again.outcome?.turnsElapsed, 1);
    }
  });
}
for (const mode of ['data', 'index', 'meta']) {
  test(`storage: ${mode} checkpoint fsync failure reports degradation after one actual turn`, linux, async t => {
    const f = await faults(t), game = await f.api.create(identity);
    const request = { version: 1, method: 'game.wait', params: { sessionId: game.id, requestId: 'once', expectedRevision: game.state.revision } };
    await f.inject(mode);
    const result = await f.transport.send(request);
    assert.equal(result.error, undefined); assert.equal(result.observation.turn, game.observation.turn + 1);
    assert.equal(result.recording.status, 'degraded'); assert.equal(result.recording.requiresResume, true);
    const after = await f.writes();
    const retry = await f.transport.send(request); assert.deepEqual(retry, result); assert.deepEqual(await f.writes(), after);
    await f.inject('');
    const resumed = await f.api.resume(game.id); assert.deepEqual(resumed.observation, result.observation);
    const receipt = await f.transport.send(request);
    assert.deepEqual(receipt.observation, result.observation);
    assert.equal(receipt.error, undefined);
  });
}
