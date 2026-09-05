import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture, identity } from './native-fixture.mjs';

test('compacted sidecars retain every old receipt through the authoritative journal after cold resume', async t => {
  const f = await fixture(t), game = await f.api.create(identity), saved = [];
  const meta = `${f.sessions}/${game.id}/meta.json`;
  for (let i = 0; i < 70; i++) {
    const o = game.observation, you = o.you;
    const direction = [['east', 1, 0], ['west', -1, 0], ['south', 0, 1], ['north', 0, -1]]
      .find(([, dx, dy]) => o.world.some(c => c.x === you.x + dx && c.y === you.y + dy && c.terrain.type === 'floor' && !c.occupant))?.[0];
    assert.ok(direction, 'real engine provides a perceived walking step');
    const request = { version: 1, method: 'game.move', params: {
      sessionId: game.id, requestId: `compact-${i}`, expectedRevision: game.state.revision, direction,
    } };
    const receipt = await f.transport.send(request);
    assert.equal(receipt.error, undefined);
    await game.observe();
    saved.push({ request, receipt });
    const metadata = JSON.parse(await readFile(meta, 'utf8'));
    assert.deepEqual(metadata.requests, [], 'only uncheckpointed receipts belong in the sidecar');
  }
  const input = await readFile(`${f.sessions}/${game.id}/input.log.jsonl`);
  await f.transport.close();
  const cold = await fixture(t, { sessions: f.sessions });
  await cold.api.resume(game.id);
  const history = await readFile(`${f.sessions}/${game.id}/perceptions.jsonl`);
  for (const { request, receipt } of [saved[0], saved[33], saved[69]])
    assert.deepEqual(await cold.transport.send(request), receipt, 'cold retry returns the exact original frame');
  assert.deepEqual(await readFile(`${f.sessions}/${game.id}/input.log.jsonl`), input);
  assert.deepEqual(await readFile(`${f.sessions}/${game.id}/perceptions.jsonl`), history, 'receipt lookup adds no new history');
});
