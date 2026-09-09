import { createHash } from 'node:crypto';
import { replayDocument, inputRecords, validateManifest } from '../../../lib/neonethack/wasm/protocol-reader.mjs';

export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class InvalidReplay extends Error {}
export class MissingReplay extends Error {}
export async function publicDocument(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000), credentials: 'omit', redirect: 'error' });
  if (response.status === 404) throw new MissingReplay('Missing public object');
  if (!response.ok) throw Error('Public object request failed: ' + response.status);
  try { return await replayDocument(response); }
  catch (e) {
    if (e instanceof SyntaxError || /checksum differs|size limit/.test(e.message)) throw new InvalidReplay(e.message);
    throw e;
  }
}
/** Matches the published component's frame envelope and document bounds. Older
 * public snapshots remain presentation recordings, not resumable engine saves. */
export function frameManifest(m) {
  if (m?.version !== 1 || m.format || !Number.isSafeInteger(m.count) || m.count < 1 || m.count > 100000 || !Array.isArray(m.chunks) || !m.chunks.length || m.chunks.length > 100000)
    throw new InvalidReplay('Invalid frame manifest');
  for (const path of m.chunks)
    if (typeof path !== 'string' || !/^chunks\/[\w.-]+\.json$/.test(path)) throw new InvalidReplay('Invalid frame chunk path');
}
export async function* frames(m, load) {
  frameManifest(m);
  const pending = []; let next = 0, count = 0;
  for (let i = 0; i < m.chunks.length; i++) {
    while (next < m.chunks.length && next < i + 4) {
      const path = m.chunks[next++];
      const p = Promise.resolve().then(() => load(path));
      pending.push(p); p.catch(() => {});
    }
    const body = await pending.shift();
    if (!Array.isArray(body?.frames) || count + body.frames.length > m.count) throw new InvalidReplay('Invalid frame range');
    for (const frame of body.frames) {
      if (!frame || typeof frame !== 'object' || !frame.observation || !Array.isArray(frame.observation.world) || frame.observation.world.length > 10000)
        throw new InvalidReplay('Invalid public snapshot');
      count++; yield frame;
    }
  }
  if (count !== m.count) throw new InvalidReplay('Frame count differs');
}
export async function inspectFrames(m, load) {
  const hash = createHash('sha256'); let count = 0;
  for await (const frame of frames(m, load)) { hash.update(JSON.stringify(frame) + '\n'); count++; }
  return { count, digest: hash.digest('hex') };
}
export async function inspectInputs(m, url) {
  try {
    validateManifest(m);
    const hash = createHash('sha256'); let count = 0;
    for await (const record of inputRecords(m, new URL(url), { signal: AbortSignal.timeout(300000) })) {
      hash.update(JSON.stringify(record) + '\n'); count++;
    }
    return { count, digest: hash.digest('hex') };
  } catch (e) {
    if (e instanceof SyntaxError || /Invalid |differs|missing or invalid|exceeds|outside|identity|checksum/.test(e.message)) throw new InvalidReplay(e.message);
    if (/not reached online backup/.test(e.message)) throw new MissingReplay('Missing input chunk');
    throw e;
  }
}
