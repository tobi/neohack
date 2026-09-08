import test from 'node:test';
import assert from 'node:assert/strict';
import { formatItems, resolveItemSelection, summarizeItems } from './presentation.mjs';

// Disposable public-shape fixtures; no historical session IDs or game stores.
const ration = (id, location = 'inventory') => ({
  id, label: 'an uncursed food ration', location, quantity: 1,
  known: { appearance: 'food ration', identity: 'food ration' },
  actions: ['eat', 'drop'],
});
function frame() {
  return {
    version: 1, sessionId: 'fixture-session-A', revision: 10,
    ended: false, end: null, decision: null,
    observation: {
      inventoryKnown: true, inventory: [ration('opaque-A'), ration('opaque-B')],
      here: { known: true, items: [ration('ground-ref', 'here')] },
      perception: { version: 1, inventory: 'current', here: 'current', equipment: 'current' },
    },
  };
}
const select = (f, id, action = 'eat') => ({ sessionId: f.sessionId, revision: f.revision, id, action });

// Stand-in input sink makes the no-input boundary observable. Production dispatch
// belongs to the integrating harness and must also enforce receipt/recovery gates.
function inputSink(getLatestFrame) {
  const calls = [];
  return {
    calls,
    send(selection) {
      const result = resolveItemSelection(getLatestFrame(), selection);
      if (result.ok) calls.push({ action: selection.action, item: result.item,
        sessionId: result.sessionId, expectedRevision: result.expectedRevision });
      return result;
    },
  };
}

test('identical rations keep distinct exact refs and all compact selection facts', () => {
  const f = frame();
  const output = formatItems(f);
  const rows = output.split('\n').filter(line => line.startsWith('{')).map(JSON.parse);
  assert.deepEqual(rows.map(item => item.id), ['opaque-A', 'opaque-B', 'ground-ref']);
  assert.deepEqual(rows[0], { id: 'opaque-A', label: 'an uncursed food ration',
    appearance: 'food ration', identity: 'food ration', location: 'inventory',
    quantity: 1, actions: ['eat', 'drop'], usage: null, equipmentSlots: null });
  assert.equal(rows[2].location, 'here');
  assert.match(output, /not safety guarantees/);
});

test('inventory and ground input use supplied IDs, never a slot or label', () => {
  const f = frame();
  f.observation.inventory[0].slot = 'f';
  const sink = inputSink(() => f);
  for (const id of ['item-f', 'f', 'an uncursed food ration']) {
    assert.equal(sink.send(select(f, id)).reason, 'unavailableReference');
  }
  assert.equal(sink.send({ ...select(f), slot: 'f' }).reason, 'selectionRequired');
  assert.equal(sink.calls.length, 0);
  sink.send(select(f, 'opaque-B'));
  sink.send(select(f, 'ground-ref'));
  assert.deepEqual(sink.calls.map(call => call.item), [{ id: 'opaque-B' }, { id: 'ground-ref' }]);
  // Opaque means no ID syntax assumptions either, if the protocol supplies it.
  f.observation.inventory[0].id = 'item-f';
  assert.equal(sink.send(select(f, 'item-f')).item.id, 'item-f');
});

test('absent old-run ref is rejected locally and explicit valid correction succeeds', () => {
  const f = frame();
  const sink = inputSink(() => f);
  assert.equal(sink.send(select(f, 'old-run-ref')).reason, 'unavailableReference');
  assert.equal(sink.calls.length, 0);
  assert.equal(sink.send(select(f, 'opaque-A')).ok, true);
  assert.equal(sink.calls.length, 1);
  assert.deepEqual(sink.calls[0], { action: 'eat', item: { id: 'opaque-A' },
    sessionId: f.sessionId, expectedRevision: 10 });
});

test('latest frame rejects old session even with matching ID, and old revision', () => {
  let current = frame();
  const selection = select(current, 'opaque-A');
  const sink = inputSink(() => current);
  current = { ...frame(), sessionId: 'fixture-session-B' };
  assert.equal(sink.send(selection).reason, 'sessionMismatch');
  current = { ...frame(), revision: 11 };
  assert.equal(sink.send(selection).reason, 'staleRevision');
  assert.equal(sink.calls.length, 0);
});

test('partial ration displays newly returned ref; only explicit selection resumes eating', () => {
  let current = frame();
  const sink = inputSink(() => current);
  const before = select(current, 'opaque-A');
  sink.send(before);
  current = frame();
  current.revision++;
  current.observation.inventory = [{ ...ration('partial-now'), label: 'a partly eaten food ration' }];
  const output = formatItems(current);
  assert.match(output, /partial-now/);
  assert.match(output, /partly eaten food ration/);
  assert.doesNotMatch(output, /opaque-A/);
  assert.equal(sink.calls.length, 1, 'formatting never resumes an occupation');
  assert.equal(sink.send(before).reason, 'staleRevision');
  assert.equal(sink.send(select(current, 'opaque-A')).reason, 'unavailableReference');
  assert.equal(sink.calls.length, 1);
  assert.equal(sink.send(select(current, 'partial-now')).ok, true);
  assert.deepEqual(sink.calls[1].item, { id: 'partial-now' });
});

test('unknown facts stay unknown despite suggestive labels and extra fields', () => {
  const f = frame();
  f.observation.inventory = [{ id: 'unidentified', label: 'a smoky potion', location: 'inventory',
    quantity: 2, category: 'potion', hiddenIdentity: 'healing' }];
  const row = summarizeItems(f).inventory.items[0];
  assert.equal(row.identity, null);
  assert.equal(row.appearance, null);
  assert.equal(row.actions, null);
  assert.doesNotMatch(formatItems(f), /healing/);
  assert.equal(resolveItemSelection(f, select(f, 'unidentified', 'drink')).reason, 'actionsUnknown');
  assert.match(formatItems(f), /null = unknown/);
});

test('unknown and remembered collections remain distinct from known empty', () => {
  const f = frame();
  f.observation.perception.inventory = 'lastKnown';
  f.observation.inventoryKnown = false;
  assert.match(formatItems(f), /inventory \(lastKnown\)/);
  assert.equal(resolveItemSelection(f, select(f, 'opaque-A')).reason, 'perceptionNotCurrent');
  f.observation.perception.here = 'unknown';
  f.observation.here = { known: false, items: [] };
  assert.match(formatItems(f), /here \(unknown\): unknown/);
  f.observation.here = { known: true, items: [] };
  f.observation.perception.here = 'current';
  assert.match(formatItems(f), /here \(current\): empty/);
  delete f.observation.perception;
  assert.equal(summarizeItems(f).here.freshness, 'unknown');
});

test('duplicate exact refs, wrong location and unavailable action remain explicit failures', () => {
  const f = frame();
  f.observation.inventory.push(ration('opaque-A'));
  assert.equal(resolveItemSelection(f, select(f, 'opaque-A')).reason, 'ambiguousReference');
  f.observation.inventory.pop();
  f.observation.inventory[0].location = 'here';
  assert.equal(resolveItemSelection(f, select(f, 'opaque-A')).reason, 'locationMismatch');
  assert.equal(resolveItemSelection(f, select(f, 'opaque-B', 'drink')).reason, 'actionNotOffered');
});

test('missing or partial inventory/ground knowledge never authorizes a reference', () => {
  for (const location of ['inventory', 'here']) {
    const id = location === 'inventory' ? 'opaque-A' : 'ground-ref';
    for (const missing of ['known', 'items', 'perception']) {
      const f = frame();
      if (missing === 'known') {
        if (location === 'inventory') f.observation.inventoryKnown = false;
        else f.observation.here.known = false;
      } else if (missing === 'items') {
        if (location === 'inventory') delete f.observation.inventory;
        else delete f.observation.here.items;
      } else delete f.observation.perception[location];
      assert.equal(summarizeItems(f)[location].freshness, 'unknown');
      const sink = inputSink(() => f);
      assert.equal(sink.send(select(f, id)).ok, false);
      assert.equal(sink.calls.length, 0);
    }
  }
});

test('labels and opaque references round-trip without becoming extra output rows', () => {
  const f = frame();
  f.observation.inventory[0].id = 'opaque-"\\\nref';
  f.observation.inventory[0].label = 'a ration\nDECISION: invented';
  const lines = formatItems(f).split('\n');
  const row = JSON.parse(lines.find(line => line.startsWith('{')));
  assert.equal(row.id, f.observation.inventory[0].id);
  assert.equal(row.label, f.observation.inventory[0].label);
  assert.ok(!lines.some(line => line.startsWith('DECISION:')));
  assert.equal(resolveItemSelection(f, select(f, row.id)).item.id, row.id);
});

test('standing decisions, terminal and unavailable frames cannot become named item input', () => {
  for (const patch of [{ decision: { id: 'question-1', kind: 'confirmation' } },
    { decision: { id: 'question-2', kind: 'item', options: [ration('opaque-A')] } },
    { ended: true }, { end: { kind: 'death' } }, { error: { code: 'uncertain' } },
    { historical: true }, { observation: undefined }, { decision: undefined }]) {
    const f = { ...frame(), ...patch };
    const sink = inputSink(() => f);
    assert.equal(sink.send(select(f, 'opaque-A')).ok, false);
    assert.equal(sink.calls.length, 0);
  }
});

test('equipment presentation copies only returned usage and slots, without inferring from label', () => {
  const f = frame();
  f.observation.inventory[0] = { ...ration('gear'), label: 'a dagger (weapon in hand)',
    usage: ['wielded'], equipmentSlots: ['weapon'] };
  f.observation.inventory[1].label = 'a dagger (weapon in hand)';
  let rows = summarizeItems(f).inventory.items;
  assert.deepEqual(rows[0].usage, ['wielded']);
  assert.deepEqual(rows[0].equipmentSlots, ['weapon']);
  assert.equal(rows[1].usage, null);
  assert.equal(rows[1].equipmentSlots, null);
  rows[0].usage.push('invented');
  rows[0].equipmentSlots.push('invented');
  rows = formatItems(f).split('\n').filter(line => line.startsWith('{')).map(JSON.parse);
  assert.deepEqual(rows[0].usage, ['wielded']);
  assert.deepEqual(rows[0].equipmentSlots, ['weapon']);
  f.observation.inventory[1].usage = [];
  f.observation.inventory[1].equipmentSlots = [];
  assert.deepEqual(summarizeItems(f).inventory.items[1].equipmentSlots, []);
});

test('raw delta, unknown outcome and storage/recording failures never authorize input', () => {
  for (const [patch, reason] of [
    [{ update: { kind: 'delta', id: 2, base: 1 } }, 'unreconstructedDelta'],
    [{ outcome: { status: 'unknown' } }, 'recoveryRequired'],
    [{ storage: { status: 'degraded' } }, 'recoveryRequired'],
    [{ recording: { status: 'failed' } }, 'recoveryRequired'],
  ]) {
    const f = { ...frame(), ...patch };
    const sink = inputSink(() => f);
    assert.equal(sink.send(select(f, 'opaque-A')).reason, reason);
    assert.equal(sink.calls.length, 0);
  }
  const f = { ...frame(), storage: { status: 'ok' }, recording: { status: 'ok' } };
  assert.equal(resolveItemSelection(f, select(f, 'opaque-A')).ok, true);
});

test('presentation and selection leave the original public frame untouched', () => {
  const f = frame();
  const before = structuredClone(f);
  formatItems(f);
  resolveItemSelection(f, select(f, 'opaque-A'));
  const summary = summarizeItems(f);
  summary.inventory.items[0].actions.push('invented');
  summary.here.items[0].label = 'changed';
  assert.deepEqual(f, before);
});
