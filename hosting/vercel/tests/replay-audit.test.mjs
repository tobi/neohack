import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage, createTestHarness, publicStoreFor } from './server.mjs';
import { storageContext, Conflict } from '../src/storage.ts';
import { publicReplayContext } from '../src/public-replay-store.ts';
import { auditReplayAvailability, ledgerRun, ledgerStats, markChronicled, markRecorded, replaySource, replayState, saveLedgerRun, rebuildLedgerSummaries } from '../src/ledger-store.ts';
import { auditOne, compactFrames, FRAME_CHUNK_BYTES } from '../scripts/audit-public-replays.mjs';
import { frames, inspectFrames, fingerprint } from '../scripts/replay-inspection.mjs';
import { WasmTransport } from '../../../lib/neonethack/dist/typescript/wasm.js';
import { chromium } from '../../../web/neohack.dev/node_modules/playwright-core/index.mjs';

const hero = (id = 'audited') => ({ id, name: 'Audited hero', role: 'valkyrie', turn: 20, ended: true, endKind: 'quit', updatedAt: Date.now(), maxLevel: 4, maxDepth: 3 });
const scope = (store, fn) => storageContext.run(store, () => publicReplayContext.run(publicStoreFor(store), fn));
const verdict = async (id, reason) => ({ available: reason === 'verified', reason, source: await replaySource(id), version: (await replayState(id))?.version ?? 0 });

test('negative audits persist through metadata, publication hints, chronicle indexing and rebuild without losing a ledger row', async () => {
  const store = new MemoryStorage();
  await scope(store, async () => {
    await saveLedgerRun(hero()); await markRecorded('audited'); await markChronicled('audited');
    const original = await ledgerRun('audited'), totals = (await ledgerStats()).totals;
    assert.equal(await auditReplayAvailability('audited', await verdict('audited', 'invalid')), true);
    await saveLedgerRun(original); await markRecorded('audited'); await markChronicled('audited'); await rebuildLedgerSummaries();
    const stats = await ledgerStats();
    assert.deepEqual(stats.totals, totals); assert.deepEqual(await ledgerRun('audited'), original);
    assert.equal(stats.recorded.length, 0);
    for (const list of [stats.best, stats.recent, stats.records.today.level, stats.records.week.depth]) {
      assert.equal(list[0].replayAvailable, false); assert.equal(list[0].chronicleAvailable, true);
    }
    assert.equal(await auditReplayAvailability('audited', await verdict('audited', 'verified')), true);
    assert.equal((await ledgerStats()).recorded[0].id, 'audited');
  });
});

test('publication precedes metadata; a private unadvertised input head does not enable replay; new publication repairs a missing verdict', async () => {
  const store = new MemoryStorage();
  await scope(store, async () => {
    await store.write('input-runs/not-published.json', { count: 20 });
    await saveLedgerRun(hero('not-published'));
    assert.equal((await ledgerStats()).recorded.length, 0);
    await auditReplayAvailability('audited', await verdict('audited', 'missing'));
    await publicStoreFor(store).write('replays/audited/manifest.json', { version: 1, count: 1, chunks: ['chunks/one.json'] });
    await markRecorded('audited'); await saveLedgerRun(hero());
    assert.equal((await ledgerStats()).recorded[0].id, 'audited');
  });
});

test('changed sources and a newer audit reject stale availability verdicts', async () => {
  const store = new MemoryStorage();
  await scope(store, async () => {
    await saveLedgerRun(hero()); const old = await verdict('audited', 'missing');
    await publicStoreFor(store).write('replays/audited/manifest.json', { count: 1 });
    assert.equal(await auditReplayAvailability('audited', old), false);
    const valid = await verdict('audited', 'verified');
    assert.equal(await auditReplayAvailability('audited', valid), true);
    assert.equal(await auditReplayAvailability('audited', { ...valid, available: false, reason: 'invalid' }), false);
    assert.equal((await ledgerStats()).recorded.length, 1);
  });
});

test('a delayed positive shard write cannot reverse a newer negative audit', async () => {
  const store = new MemoryStorage();
  await scope(store, async () => {
    await saveLedgerRun(hero());
    let entered, release; const waiting = new Promise(r => entered = r), held = new Promise(r => release = r);
    const write = store.write.bind(store); let stopped = false;
    store.write = async (path, value, etag) => {
      if (!stopped && path.startsWith('ledger/shards/') && value.entries.audited?.replay?.version === 1) {
        stopped = true; entered(); await held;
      }
      return write(path, value, etag);
    };
    const positive = auditReplayAvailability('audited', await verdict('audited', 'verified'));
    try {
      await waiting;
      assert.equal(await auditReplayAvailability('audited', await verdict('audited', 'invalid')), true);
    } finally { release(); await positive; }
    assert.equal((await ledgerStats()).recorded.length, 0);
    assert.equal((await replayState('audited')).version, 2);
  });
});

test('whole-archive audit hides missing/corrupt data but never interprets an outage as a broken recording', async t => {
  const server = createTestHarness(), { url } = await server.listen(); t.after(() => server.close());
  const store = server.store, cdn = publicStoreFor(store), origin = new URL('/replay-files/', url).href;
  await scope(store, async () => {
    for (const id of ['missing', 'invalid', 'outage']) { await saveLedgerRun(hero(id)); await markRecorded(id); }
    let result = await auditOne('missing', { apply: true, origin });
    assert.equal(result.status, 'missing'); assert.equal(result.applied, true);
    await cdn.write('replays/invalid/manifest.json', { version: 1, count: 1, chunks: ['chunks/one.json'] });
    await cdn.write('replays/invalid/chunks/one.json', { frames: [] });
    result = await auditOne('invalid', { apply: true, origin });
    assert.equal(result.status, 'invalid'); assert.equal(result.applied, true);
    const before = await replayState('outage'), read = cdn.read.bind(cdn);
    cdn.read = async path => { if (path === 'replays/outage/manifest.json') throw Error('storage outage'); return read(path); };
    result = await auditOne('outage', { apply: true, origin });
    assert.equal(result.status, 'uncertain'); assert.equal(result.applied, undefined);
    assert.deepEqual(await replayState('outage'), before);
    assert.deepEqual((await ledgerStats()).recorded.map(r => r.id), ['outage']);
  });
});

test('frame compaction cannot overwrite a playlist advanced by another publisher', async () => {
  const store = new MemoryStorage(), cdn = publicStoreFor(store), prefix = 'replays/raced/';
  const frame = { observation: { world: [], location: {}, vitals: {}, heard: [] } };
  const original = { version: 1, count: 4, chunks: Array.from({ length: 4 }, (_, i) => 'chunks/' + i + '.json') };
  for (const p of original.chunks) await cdn.write(prefix + p, { frames: [frame] });
  await cdn.write(prefix + 'manifest.json', original);
  const prior = await cdn.read(prefix + 'manifest.json');
  const later = { ...original, complete: true };
  await cdn.write(prefix + 'manifest.json', later, prior.etag);
  await scope(store, () => assert.rejects(compactFrames('raced', original, prior.etag), Conflict));
  assert.deepEqual((await cdn.read(prefix + 'manifest.json')).value, later);
  for (const p of original.chunks) assert.ok(await cdn.read(prefix + p));
});

test('already economical frame playlists incur no replacement Blob writes or duplicate stream downloads', async t => {
  const server = createTestHarness(), { url } = await server.listen(); t.after(() => server.close());
  const store = server.store, cdn = publicStoreFor(store), prefix = 'replays/economical/';
  const frame = { observation: { world: [], location: {}, vitals: {}, heard: ['x'.repeat(900000)] } };
  const manifest = { version: 1, count: 6, chunks: ['chunks/a.json', 'chunks/b.json', 'chunks/c.json'] };
  for (const p of manifest.chunks) await cdn.write(prefix + p, { frames: [frame, frame] });
  await cdn.write(prefix + 'manifest.json', manifest);
  const checked = await inspectFrames(manifest, async p => (await cdn.read(prefix + p)).value);
  assert.equal(checked.packingChunks, 4);
  let downloads = 0; const read = cdn.read.bind(cdn);
  cdn.read = async path => { if (path.startsWith(prefix + 'chunks/')) downloads++; return read(path); };
  cdn.write = async () => { assert.fail('No candidate objects or playlists should be written'); };
  await scope(store, async () => {
    await saveLedgerRun(hero('economical'));
    const result = await auditOne('economical', { apply: true, origin: new URL('/replay-files/', url).href });
    assert.equal(result.status, 'verified', JSON.stringify(result)); assert.equal(result.applied, true);
    assert.equal(result.before, result.after);
  });
  assert.equal(downloads, 3, 'the three unchanged immutable chunks are read just once');
});

test('a real public frame recording compacts to bounded files, preserves exact scenes and renders in the current embed', { timeout: 90000 }, async t => {
  const engine = await WasmTransport.create();
  let initial;
  try { initial = await engine.send({ version: 1, method: 'session.create', params: { name: 'Frame audit', role: 'valkyrie', seed: 9 } }); }
  finally { await engine.close(); }
  assert.ok(initial.observation);
  const server = createTestHarness(), { url } = await server.listen(); t.after(() => server.close());
  const store = server.store, cdn = publicStoreFor(store), id = 'old-public', prefix = 'replays/' + id + '/';
  // Repeated copies test storage boundaries, not additional engine turns.
  const snapshots = Array.from({ length: 120 }, () => structuredClone(initial));
  const paths = [];
  for (let i = 0; i < snapshots.length; i++) { const path = 'chunks/frame-' + i + '.json'; paths.push(path); await cdn.write(prefix + path, { frames: [snapshots[i]] }); }
  const manifest = { version: 1, count: snapshots.length, chunks: paths, role: 'valkyrie', seed: 9, partial: true, complete: false };
  await cdn.write(prefix + 'manifest.json', manifest);
  const read = cdn.read.bind(cdn);
  cdn.head = async path => { const doc = await read(path); return doc && { etag: doc.etag }; };
  cdn.read = async path => {
    const doc = await read(path);
    // Both a stale body and a CDN validator can outlive a successful write.
    // Query strings do not necessarily bypass that cached alias.
    return doc && path === prefix + 'manifest.json' ? { value: manifest, etag: 'cdn-validator' } : doc;
  };
  await scope(store, async () => {
    await saveLedgerRun(hero(id));
    const before = await inspectFrames(manifest, async p => (await cdn.read(prefix + p)).value);
    const result = await auditOne(id, { apply: true, origin: new URL('/replay-files/', url).href });
    assert.equal(result.status, 'verified', JSON.stringify(result)); assert.equal(result.applied, true);
    assert.ok(result.after < result.before / 2, JSON.stringify(result)); assert.equal(result.digest, before.digest);
    const after = (await read(prefix + 'manifest.json')).value;
    assert.equal(result.after, after.chunks.length, 'verify the written version, not the stale CDN alias');
    assert.deepEqual((await read(prefix + 'manifest-' + fingerprint(after) + '.json')).value, after);
    assert.equal(after.partial, true); assert.equal(after.complete, false);
    const restored = [];
    for await (const frame of frames(after, async p => {
      const value = (await cdn.read(prefix + p)).value;
      assert.ok(Buffer.byteLength(JSON.stringify(value)) <= FRAME_CHUNK_BYTES); return value;
    })) restored.push(frame);
    assert.deepEqual(restored, snapshots);
    for (const path of paths) assert.ok(await cdn.read(prefix + path), 'old links retained');
    assert.deepEqual(await inspectFrames(manifest, async p => (await cdn.read(prefix + p)).value), before);
  });
  cdn.read = read; // Cache expires before the embed opens the published alias.
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true, chromiumSandbox: true }); t.after(() => browser.close());
  const page = await browser.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(new URL('/replays/' + id, url).href);
  await page.waitForFunction(() => document.querySelector('#replay')?.frames?.length === 120 && !document.querySelector('#replay')?.sourcePending);
  for (const index of [0, 119, 1]) {
    const scene = await page.evaluate(async i => { const p = document.querySelector('#replay'); await p.seek(i); return p.snapshot; }, index);
    assert.deepEqual(scene.observation, initial.observation);
  }
  assert.deepEqual(errors, []);
});
