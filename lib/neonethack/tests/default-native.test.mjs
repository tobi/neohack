import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Nethack, { Neonethack } from 'neonethack';

test('default package entry locates the native engine and C resumes a standing decision', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'neonethack-default-'));
  const sessionsPath = join(directory, 'sessions');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previous = process.cwd();
  process.chdir(directory);
  const api = new Nethack();
  assert.ok(api instanceof Neonethack);
  let saved;
  try {
    const game = await api.create({ name: 'Ada', role: 'valkyrie', seed: 42 });
    saved = await game.pray();
    assert.equal(saved.decision.kind, 'confirmation');
    await game.close();
  } finally { await api.close(); process.chdir(previous); }
  const reopened = new Nethack({ sessionsPath });
  try {
    const game = await reopened.resume(saved.sessionId);
    assert.deepEqual(game.observation, saved.observation);
    assert.deepEqual(game.decision, saved.decision);
    const declined = await game.answer(game.decision.id, { kind: 'confirmation', confirm: false });
    assert.equal(declined.observation.turn, saved.observation.turn);
  } finally { await reopened.close(); }
});
