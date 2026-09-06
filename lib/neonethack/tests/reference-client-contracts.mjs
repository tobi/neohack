import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Neonethack } from '../dist/typescript/client.js';
import { ReferenceClient } from '../dist/typescript/reference-client.js';
import { PublicTrace } from '../dist/typescript/public-trace.js';
import { gunzipSync } from 'node:zlib';
const identity = { name: 'Reference', seed: 42, role: 'valkyrie', race: 'dwarf', gender: 'female', align: 'lawful' };
export function referenceContracts(label, fixture) {
  test(`${label} manual reference client preserves distinct consent, receipt recovery and actual full trace`, { timeout: 60000 }, async t => {
    const { transport, packageId } = await fixture(t);
    const trace = new PublicTrace({ runId: 'fresh-life', processId: 'one-process', codeVersion: 'reference-client-v1',
      runtime: { backend: label === 'WASM' ? 'wasm' : 'native', packageId, libraryVersion: (await new Neonethack(transport).describe()).libraryVersion, runtimeProfile: 1 } });
    let lose = false, dropped;
    const traced = trace.wrap({ close: () => transport.close(), async send(request) {
      const result = await transport.send(request);
      if (lose && request.method === 'game.search') { lose = false; dropped = result; throw Error('injected reply loss'); }
      return result;
    } });
    const api = new Neonethack(traced), game = await api.create(identity), client = new ReferenceClient(game);
    const prayer = await client.choose({ kind: 'pray' });
    assert.equal(prayer.decision.kind, 'confirmation');
    await assert.rejects(client.choose({ kind: 'wait' }), /explicit answer/);
    const declined = await client.choose({ kind: 'answer', decisionId: prayer.decision.id, answer: { kind: 'confirmation', confirm: false } });
    assert.equal(declined.observation.turn, prayer.observation.turn); assert.equal(declined.decision, null);
    const second = await client.choose({ kind: 'pray' }); assert.notEqual(second.decision.id, prayer.decision.id);
    await client.choose({ kind: 'cancel', decisionId: second.decision.id });
    lose = true; await assert.rejects(client.choose({ kind: 'search' }), /may have executed/);
    const exact = game.pendingRequest; await assert.rejects(client.choose({ kind: 'wait' }), /recovery/);
    const recovered = await client.recover();
    assert.equal(recovered.revision, dropped.revision); assert.equal(recovered.observation.turn, dropped.observation.turn);
    assert.equal(client.view.inputGate.state, 'ready');
    const entries = trace.export().chunks.map(c => JSON.parse(gunzipSync(c.bytes)));
    const uncertain = entries.find(e => e.result === 'transportUncertain'); assert.deepEqual(uncertain.request, exact);
    const receipt = entries.find(e => e.request.params.requestId === exact.params.requestId && e.response);
    assert.deepEqual(receipt.response, dropped); assert.equal(receipt.runtime.packageId, packageId);
    assert.ok(entries[0].response.events.length > 0); assert.ok(trace.status.records >= 8);
  });
}
