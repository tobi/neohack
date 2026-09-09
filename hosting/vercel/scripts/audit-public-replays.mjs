// Explicit maintenance: no engine input is sent to a user's session. No model
// calls. Reports contain public IDs/counts/hashes only, never vaults or journals.
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Conflict, read } from '../src/storage.ts';
import { publicReplayStorage } from '../src/public-replay-store.ts';
import { ledgerRuns, ledgerStats, replayState, replaySource, auditReplayAvailability } from '../src/ledger-store.ts';
import { publishReplay } from '../src/publish-replay.ts';
import { compactProtocolReplay, publishManifest } from '../src/protocol-replays.ts';
import { collectReplay } from '../../../examples/chronicle/replay.mjs';
import { fingerprint, frames, inspectFrames, inspectInputs, publicDocument, InvalidReplay, MissingReplay } from './replay-inspection.mjs';
import { pathToFileURL } from 'node:url';

export const FRAME_CHUNK_BYTES = 2 * 1024 * 1024;
/** Replace only the playlist using CAS. All original immutable files remain.
 * First scene stays tiny; every subsequent file is bounded by encoded size. */
export async function compactFrames(id, manifest, revision) {
  if (manifest.chunks.length < 3) return manifest;
  const store = publicReplayStorage(), prefix = 'replays/' + id + '/';
  const chunks = []; let batch = [], bytes = 13, count = 0;
  const flush = async () => {
    if (!batch.length) return;
    const body = { frames: batch }, name = 'chunks/' + fingerprint(body) + '.json';
    try { await store.write(prefix + name, body); }
    catch (e) { if (!(e instanceof Conflict)) throw e; if (fingerprint((await store.read(prefix + name))?.value) !== fingerprint(body)) throw new InvalidReplay('Immutable frames differ'); }
    chunks.push(name); batch = []; bytes = 13;
  };
  for await (const frame of frames(manifest, async path => {
    const doc = await store.read(prefix + path);
    if (!doc) throw new MissingReplay('Missing frame chunk');
    return doc.value;
  })) {
    const size = Buffer.byteLength(JSON.stringify(frame)) + 1;
    if (size > FRAME_CHUNK_BYTES - 13) throw Error('A frame exceeds the compaction target; retain original playlist');
    if (bytes + size > FRAME_CHUNK_BYTES || batch.length >= 256) await flush();
    batch.push(frame); bytes += size; count++;
    if (count === 1) await flush();
  }
  await flush();
  if (chunks.length >= manifest.chunks.length) return manifest;
  const packed = { ...manifest, chunks };
  await store.write(prefix + 'manifest.json', packed, revision);
  return packed;
}

export async function verifyEngine(url, expected, options = {}) {
  let count = 0; const hash = createHash('sha256');
  const collector = { hero: {}, add(reply) {
    if (!reply?.observation || !Array.isArray(reply.observation.world)) throw new InvalidReplay('Input produced no public scene');
    hash.update(JSON.stringify(reply) + '\n'); count++; return true;
  }, finish: () => ({ count, scenes: hash.digest('hex') }) };
  try {
    const result = await collectReplay(url, collector, { ...options, signal: AbortSignal.timeout(600000) });
    if (count !== expected) throw Error('Archive changed during verification');
    return result;
  } catch (e) {
    if (/Replay (?:RNG boundaries )?differs at input|Runtime checksum differs|Pinned runtime manifest differs/.test(e.message)) throw new InvalidReplay(e.message);
    if (/Pinned runtime unavailable \(404\)/.test(e.message)) throw new MissingReplay('Missing pinned runtime');
    throw e;
  }
}

export async function auditOne(id, { apply = false, origin = process.env.PUBLIC_REPLAY_ORIGIN, verify = verifyEngine } = {}) {
  const store = publicReplayStorage(), path = 'replays/' + id + '/manifest.json';
  const row = { id, status: 'uncertain' };
  let source, version, manifest;
  try {
    source = await replaySource(id); version = (await replayState(id))?.version ?? 0;
    let published = await store.read(path);
    if (apply) {
      const inputs = await read('input-runs/' + id + '.json');
      const recording = inputs ? null : await read('replays/' + id + '.json');
      if (inputs?.count > 0 && (!published || published.value.count < inputs.count || published.value.generation < inputs.generation)) await publishManifest(id);
      else if (recording?.frames?.length > 0 && (!published || published.value.count < recording.frames.length)) await publishReplay(id);
      published = await store.read(path);
    }
    source = await replaySource(id); version = (await replayState(id))?.version ?? 0;
    if (!published) throw new MissingReplay('Missing public manifest');
    // A fresh query prevents a mutable CDN alias lagging its management token.
    const url = new URL(path, origin.endsWith('/') ? origin : origin + '/');
    url.searchParams.set('audit', source);
    manifest = await publicDocument(url);
    if (fingerprint(manifest) !== fingerprint(published.value)) throw Error('Public manifest is not yet consistent');
    row.format = manifest.format ?? 'frames'; row.count = manifest.count;
    row.before = manifest.chunks?.length;
    let checked;
    if (manifest.format === 'neonethack.inputs') {
      if (manifest.id !== id) throw new InvalidReplay('Input manifest identity differs');
      checked = await inspectInputs(manifest, url);
      row.engine = await verify(url, manifest.count);
      if (apply) {
        if (source !== await replaySource(id)) throw Error('Archive changed during verification');
        await compactProtocolReplay(id);
      }
    } else {
      checked = await inspectFrames(manifest, p => publicDocument(new URL(p, url)));
      if (apply) {
        if (source !== await replaySource(id)) throw Error('Archive changed during verification');
        await compactFrames(id, manifest, published.etag);
      }
    }
    if (apply) {
      source = await replaySource(id);
      url.searchParams.set('audit', source);
      const after = await publicDocument(url);
      const again = after.format === 'neonethack.inputs'
        ? await inspectInputs(after, url)
        : await inspectFrames(after, p => publicDocument(new URL(p, url)));
      if (checked.count !== again.count || checked.digest !== again.digest) throw Error('Compacted replay stream differs');
      // Compaction cannot change completion, role, engine pin or checkpoints.
      const semantics = m => { const { chunks, generation, ...rest } = m; return rest; };
      if (fingerprint(semantics(manifest)) !== fingerprint(semantics(after))) throw Error('Compacted replay metadata differs');
      row.after = after.chunks.length;
    } else row.after = row.before;
    if (source !== await replaySource(id)) throw Error('Archive changed during verification');
    row.digest = checked.digest; row.status = 'verified';
  } catch (e) {
    row.status = e instanceof MissingReplay ? 'missing' : e instanceof InvalidReplay || /^(Public recording incomplete|Public recording frame differs|Stored object hash differs)$/.test(e.message) ? 'invalid' : 'uncertain';
    // Only controlled messages from our validators are exported. Unknown errors
    // may carry a URL; keep them private and classify without exposing it.
    row.reason = ['missing', 'invalid'].includes(row.status) ? e.message : e instanceof Conflict ? 'Concurrent publication' : 'Verification incomplete: ' + e.name;
  }
  if (apply && row.status !== 'uncertain' && source && version !== undefined) {
    try {
      row.applied = await auditReplayAvailability(id, { available: row.status === 'verified', reason: row.status, source, version });
      if (!row.applied) row.status = 'changed';
    } catch {
      row.status = 'uncertain'; row.reason = 'Availability publication did not finish';
    }
  }
  return row;
}

export async function main(args = process.argv.slice(2)) {
  let apply = false, run, report = 'replay-audit.json';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--audit-replays') continue;
    if (args[i] === '--apply') apply = true;
    else if (args[i] === '--run') run = args[++i];
    else if (args[i] === '--report') report = args[++i];
    else throw Error('Usage: --audit-replays [--apply] [--run ID] [--report FILE]');
  }
  if (run !== undefined && !/^[\w-]{1,64}$/.test(run)) throw Error('Invalid public run');
  const started = new Date().toISOString(), runs = await ledgerRuns(), before = (await ledgerStats()).totals;
  if (!run && runs.length !== before.runs) throw Error('Ledger source/index totals differ; refusing a partial audit');
  const selected = run ? runs.filter(r => r.id === run) : runs;
  if (run && !selected.length) throw Error('Run not in ledger');
  const rows = []; let next = 0, saving = Promise.resolve();
  // Memory and request concurrency are bounded; there is no per-view audit.
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (next < selected.length) {
      const row = await auditOne(selected[next++].id, { apply }); rows.push(row);
      console.log(JSON.stringify(row));
      const snapshot = JSON.stringify({ started, apply, total: selected.length, before, rows }, null, 2);
      saving = saving.then(() => writeFile(report, snapshot)); await saving;
    }
  }));
  const summary = { started, finished: new Date().toISOString(), apply, total: selected.length, before, after: (await ledgerStats()).totals,
    statuses: rows.reduce((a, r) => (a[r.status] = (a[r.status] ?? 0) + 1, a), {}),
    chunksBefore: rows.filter(r => r.status === 'verified').reduce((n, r) => n + r.before, 0),
    chunksAfter: rows.filter(r => r.status === 'verified').reduce((n, r) => n + r.after, 0) };
  await writeFile(report, JSON.stringify({ ...summary, rows }, null, 2));
  console.log(JSON.stringify(summary));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
