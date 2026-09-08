import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunLifecycle, LifecycleBlockedError, LIFECYCLE_EXIT_CODES } from './lifecycle.mjs';

// Disposable public-shape fixtures reflecting the selected audit facts. No
// recordings, historical session IDs, journals or saved games are needed.
const live = (revision = 1, extra = {}) => ({
  sessionId: 'fixture_run', revision, ended: false, end: null, ...extra,
});
const terminal = (revision = 2, kind = 'death') => live(revision, {
  ended: true, end: { kind, turn: 630 },
});
async function running() {
  const lifecycle = createRunLifecycle({ sessionId: 'fixture_run' });
  await lifecycle.acceptSnapshot(live());
  return lifecycle;
}

test('run009 id168 pattern: terminal response cancels queued mutations and permits deliberate final reads', async () => {
  const lifecycle = await running();
  const sent = [];
  const queued = new Set(['attack', 'pray', "answer"]);
  for (const name of queued) lifecycle.registerPlayJob(() => queued.delete(name));
  lifecycle.assertAllowed('play');
  sent.push('attack');
  await lifecycle.acceptSnapshot(terminal(609));
  for (const name of queued) { lifecycle.assertAllowed('play'); sent.push(name); }
  assert.deepEqual(sent, ['attack']);
  assert.throws(() => lifecycle.assertAllowed('play', { deliberate: true }), LifecycleBlockedError);
  assert.throws(() => lifecycle.assertAllowed('observe'), LifecycleBlockedError);
  lifecycle.assertAllowed('observe', { deliberate: true });
  sent.push("observe");
  await lifecycle.acceptSnapshot(terminal(609));
  lifecycle.assertAllowed('export', { deliberate: true });
  assert.deepEqual(sent, ['attack', "observe"]);
  assert.equal(lifecycle.status().exitCode, LIFECYCLE_EXIT_CODES.terminal);
  assert.equal(JSON.parse(JSON.stringify(lifecycle.status())).state, 'terminal');
});

test('run008 freeze/death pattern: stop all 505 automatic observation attempts', async () => {
  const lifecycle = await running();
  let polls = 0;
  let canceled = 0;
  lifecycle.registerPlayJob(() => canceled++);
  await lifecycle.acceptSnapshot(terminal(970));
  for (let i = 0; i < 505; i++) {
    assert.throws(() => { lifecycle.assertAllowed('poll'); polls++; }, LifecycleBlockedError);
  }
  assert.equal(polls, 0);
  assert.equal(canceled, 1);
  await lifecycle.acceptSnapshot(terminal(970));
  assert.equal(canceled, 1);
});

test('run016 id299 pattern: gas spore kill and 22 HP retain authoritative alive lifecycle', async () => {
  const lifecycle = await running();
  await lifecycle.acceptSnapshot(live(1334, {
    observation: { vitals: { health: 22 }, heard: ['The gas spore is killed!'] },
    events: [{ type: 'heard', text: 'The gas spore is killed!' }],
  }));
  assert.equal(lifecycle.status().state, 'alive');
  assert.equal(lifecycle.assertAllowed('play').exitCode, 0);
  // Neither HP text nor rolling death narration overrides exact lifecycle facts.
  await lifecycle.acceptSnapshot(live(1335, {
    observation: { vitals: { health: 0 }, heard: ['You die...'] },
  }));
  assert.equal(lifecycle.status().state, 'alive');
});

test('no implicit new session and no cross-session authority', async () => {
  assert.throws(() => createRunLifecycle(), TypeError);
  const lifecycle = await running();
  await lifecycle.acceptSnapshot(terminal());
  await assert.rejects(lifecycle.acceptSnapshot(live(3, { sessionId: 'another_run' })), TypeError);
  await assert.rejects(lifecycle.resume(live(3), { explicit: true }), LifecycleBlockedError);
  assert.throws(() => lifecycle.assertAllowed('create', { deliberate: true }), TypeError);
  assert.equal(lifecycle.status().sessionId, 'fixture_run');
  assert.equal(lifecycle.status().state, 'terminal');
});

test('unknown blocks play until exact current fields arrive', async () => {
  const lifecycle = createRunLifecycle({ sessionId: 'fixture_run' });
  assert.equal(lifecycle.status().exitCode, 22);
  assert.throws(() => lifecycle.assertAllowed('play'), LifecycleBlockedError);
  for (const bad of [live(-1), live(1.5), live(1, { ended: 'false' }),
    live(1, { end: undefined }), live(1, { end: { kind: 'death' } })]) {
    await assert.rejects(lifecycle.acceptSnapshot(bad), TypeError);
  }
  assert.equal(lifecycle.status().state, 'unknown');
  await lifecycle.acceptSnapshot(live());
  assert.equal(lifecycle.status().state, 'alive');
});

for (const kind of ['death', 'escaped', 'ascended', 'quit', 'engineError', 'unknown']) {
  test(`${kind} remains stopped despite newer live/disconnected frames or explicit resume`, async () => {
    const lifecycle = await running();
    await lifecycle.acceptSnapshot(terminal(10, kind));
    for (const frame of [live(9), live(10), live(11), terminal(12, 'disconnected')]) {
      await lifecycle.acceptSnapshot(frame);
      assert.equal(lifecycle.status().state, 'terminal');
      assert.equal(lifecycle.status().end.kind, kind);
    }
    await assert.rejects(lifecycle.resume(live(13), { explicit: true }), LifecycleBlockedError);
  });
}

test('ended true without a kind still stops; it does not invent death', async () => {
  const lifecycle = await running();
  await lifecycle.acceptSnapshot(live(2, { ended: true }));
  assert.equal(lifecycle.status().state, 'terminal');
  assert.equal(lifecycle.status().end, null);
});

test('disconnected stops jobs; only successful explicit same-session resume permits new scheduling', async () => {
  const lifecycle = await running();
  let cancels = 0;
  lifecycle.registerPlayJob(() => cancels++);
  await lifecycle.acceptSnapshot(terminal(5, 'disconnected'));
  assert.equal(cancels, 1);
  assert.equal(lifecycle.status().exitCode, 21);
  assert.throws(() => lifecycle.assertAllowed('poll'), LifecycleBlockedError);
  await lifecycle.acceptSnapshot(live(6));
  assert.equal(lifecycle.status().state, 'disconnected');
  await assert.rejects(lifecycle.resume(live(6)), LifecycleBlockedError);
  await assert.rejects(lifecycle.resume(live(4), { explicit: true }), TypeError);
  await assert.rejects(lifecycle.resume(live(6, { sessionId: 'another_run' }), { explicit: true }), TypeError);
  await assert.rejects(lifecycle.resume(live(6, { error: { code: 'recoveryRequired' } }), { explicit: true }), TypeError);
  lifecycle.assertAllowed('resume', { deliberate: true });
  await lifecycle.resume(live(6), { explicit: true });
  assert.equal(lifecycle.status().state, 'alive');
  await lifecycle.disconnect();
  assert.equal(cancels, 1); // Resume never silently restores canceled jobs.
});

test('transport disconnection is not a death result', async () => {
  const lifecycle = await running();
  await lifecycle.disconnect();
  assert.equal(lifecycle.status().state, 'disconnected');
  assert.equal(lifecycle.status().ended, false);
  assert.equal(lifecycle.status().end, null);
  await lifecycle.resume(live(1), { explicit: true });
  assert.equal(lifecycle.status().state, 'alive');
});

for (const state of ['unavailable', 'recoveryRequired', 'ended']) {
  test(`inputGate ${state} cannot reopen disconnected or terminal lifecycle`, async () => {
    const lifecycle = await running();
    const frame = live(2, { inputGate: { state } });
    await lifecycle.acceptSnapshot(frame);
    assert.equal(lifecycle.status().state, 'disconnected');
    await assert.rejects(lifecycle.resume(frame, { explicit: true }), TypeError);
    await lifecycle.acceptSnapshot(live(3));
    assert.equal(lifecycle.status().state, 'disconnected');
    await lifecycle.acceptSnapshot(terminal(4));
    await lifecycle.acceptSnapshot({ ...frame, revision: 5 });
    assert.equal(lifecycle.status().state, 'terminal');
  });
}

test('revision regression cannot replace newer authority', async () => {
  const lifecycle = await running();
  await lifecycle.acceptSnapshot(live(10));
  await lifecycle.acceptSnapshot(terminal(9, 'disconnected'));
  assert.equal(lifecycle.status().revision, 10);
  assert.equal(lifecycle.status().state, 'alive');
});

test('cancellation closes gate synchronously and attempts every job even when callbacks fail', async () => {
  const lifecycle = await running();
  const seen = [];
  const unregister = lifecycle.registerPlayJob(() => seen.push('completed job'));
  unregister();
  lifecycle.registerPlayJob(() => {
    assert.throws(() => lifecycle.assertAllowed('play'), LifecycleBlockedError);
    seen.push('failing job');
    throw new Error('scheduler unavailable');
  });
  lifecycle.registerPlayJob(async () => { seen.push('second job'); });
  const stopped = lifecycle.acceptSnapshot(terminal());
  assert.throws(() => lifecycle.assertAllowed('play'), LifecycleBlockedError);
  await assert.rejects(stopped, AggregateError);
  assert.deepEqual(seen, ['failing job', 'second job']);
  assert.equal(lifecycle.status().state, 'terminal');
  assert.throws(() => lifecycle.registerPlayJob(() => {}), LifecycleBlockedError);
});

test('external mutation cannot change retained terminal facts', async () => {
  const lifecycle = await running();
  const frame = terminal();
  await lifecycle.acceptSnapshot(frame);
  frame.end.kind = 'disconnected';
  lifecycle.status().end.kind = 'disconnected';
  assert.equal(lifecycle.status().end.kind, 'death');
});

for (const [label, diagnostic] of Object.entries({
  unknownOutcome: { outcome: { status: 'unknown' } },
  error: { error: { code: 'incompleteRequest' } },
  degradedStorage: { storage: { status: 'degraded' } },
  degradedRecording: { recording: { status: 'degraded', requiresResume: true } },
  explicitRecovery: { storage: { status: 'ok', requiresResume: true } },
  nestedRecoveryGate: { observation: { neighborhood: { inputGate: { state: 'recoveryRequired' } } } },
  nestedUnavailableGate: { observation: { neighborhood: { inputGate: { state: 'unavailable' } } } },
  disagreeingGates: { inputGate: { state: 'ready' }, observation: { neighborhood: { inputGate: { state: 'unavailable' } } } },
})) {
  test(`${label} stops jobs without inventing an ending and cannot authorize resume`, async () => {
    const lifecycle = await running();
    let canceled = 0;
    lifecycle.registerPlayJob(() => canceled++);
    const frame = live(2, diagnostic);
    await lifecycle.acceptSnapshot(frame);
    assert.equal(canceled, 1);
    assert.equal(lifecycle.status().canPlay, false);
    assert.equal(lifecycle.status().state, 'disconnected');
    assert.equal(lifecycle.status().ended, false);
    assert.equal(lifecycle.status().end, null);
    await assert.rejects(lifecycle.resume(frame, { explicit: true }), TypeError);
    await lifecycle.acceptSnapshot(live(3));
    assert.equal(lifecycle.status().canPlay, false);
    await lifecycle.resume(live(3), { explicit: true });
    assert.equal(lifecycle.status().canPlay, true);
  });
}

test('healthy diagnostics and a genuine decision preserve lifecycle without answering it', async () => {
  const lifecycle = await running();
  const decision = { id: 'decision-opaque', kind: 'confirmation' };
  const frame = live(2, {
    outcome: { status: 'needsChoice' }, decision,
    storage: { status: 'ok' }, recording: { status: 'ok' },
    observation: { neighborhood: { inputGate: { state: 'decision', decisionId: decision.id } } },
  });
  await lifecycle.acceptSnapshot(frame);
  assert.equal(lifecycle.status().canPlay, true);
  assert.deepEqual(frame.decision, decision);
});

test('sessionId is an opaque nonempty identity, not a run token', async () => {
  const sessionId = 'fixture/session:opaque';
  const lifecycle = createRunLifecycle({ sessionId });
  await lifecycle.acceptSnapshot(live(1, { sessionId }));
  assert.equal(lifecycle.status().sessionId, sessionId);
  assert.equal(lifecycle.status().canPlay, true);
});

test('persisted disconnected status restores stop even when last authoritative snapshot was alive', async () => {
  const lifecycle = await running();
  await lifecycle.disconnect();
  const persisted = JSON.parse(JSON.stringify({ status: lifecycle.status(), snapshot: live() }));
  const restored = createRunLifecycle({ sessionId: persisted.status.sessionId });
  await restored.acceptSnapshot(persisted.snapshot);
  if (persisted.status.state === 'disconnected') await restored.disconnect();
  assert.throws(() => restored.assertAllowed('play'), LifecycleBlockedError);
  await restored.resume(live(), { explicit: true });
  assert.equal(restored.status().canPlay, true);
});
