import { listen, send, worker, inNode } from './worker-port.mjs';
import { loadManifest, checked } from './assets.mjs';
import { openBlockStore } from './block-store.mjs';
let module, manifest, storage, releaseLock, store;
let booted = false;
let replicaPending = false, replicaFlight = null, replicaTimer, requestActive = false;
let replicaKnown = new Set(), replicaRevision = null, replicaFailed = false, replicaFiles = "[]";
const replicaStatus = (state, message = '') => send({ type: 'replica', state, message });
function queueReplica() {
  if (!storage.replicaUrl || replicaFailed) return;
  replicaPending = true;
  replicaStatus('pending');
  clearTimeout(replicaTimer);
  replicaTimer = setTimeout(() => { void uploadReplica(); }, 100);
}
async function uploadReplica() {
  if (replicaFlight || !replicaPending || replicaFailed) return replicaFlight;
  if (requestActive) { replicaTimer = setTimeout(() => { void uploadReplica(); }, 100); return; }
  replicaPending = false;
  replicaFlight = (async () => {
    const snapshot = await store.snapshot(replicaKnown);
    const filesKey = JSON.stringify(snapshot.files);
    if (filesKey === replicaFiles) { replicaStatus("saved"); return; }
    const commit = { ...snapshot, base: replicaRevision, commit: crypto.randomUUID() };
    const body = JSON.stringify(commit);
    await store.replicaOutbox(commit);
    let response;
    // Retry exactly the same immutable commit, never a fresh interpretation.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await fetch(storage.replicaUrl, { method: 'PUT', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(10000) });
        if (response.status < 500) break;
      } catch (error) { if (attempt === 2) throw error; }
      await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
    }
    if (!response?.ok) throw Error(response?.status === 409 ? 'Another browser has newer cloud progress. Your local run is retained; cloud sync stopped.' : 'Cloud save is pending. Your progress is retained in this browser.');
    const committed = await response.json();
    if (committed.revision !== commit.commit) throw Error('Invalid cloud commit acknowledgement');
    replicaRevision = committed.revision;
    replicaFiles = filesKey;
    replicaKnown = new Set(snapshot.files.flatMap(([, file]) => file.blocks));
    await store.replicaCursor(replicaRevision, snapshot.files);
    await store.replicaOutbox(null);
    replicaStatus(replicaPending ? 'pending' : 'saved');
  })().catch(error => {
    replicaFailed = true;
    replicaStatus('error', String(error.message ?? error));
    diagnostic(error);
  }).finally(() => {
    replicaFlight = null;
    if (replicaPending && !replicaFailed) replicaTimer = setTimeout(() => { void uploadReplica(); }, 100);
  });
  return replicaFlight;
}

let nextHandle = 1;
let tail = Promise.resolve();
const engines = new Map();
const retirements = [];
const encoder = new TextEncoder();
const diagnostic = text => send({ type: 'diagnostic', text: String(text).slice(-4096) });

function engineStop(handle) {
  const entry = engines.get(handle);
  if (!entry) return;
  entry.ended = true;
  entry.waiter?.(null);
  entry.waiter = null;
  retirements.push(Promise.resolve(entry.worker.stop()));
  engines.delete(handle);
}
function startEngine(args) {
  const handle = nextHandle++;
  const entry = { queue: [], bytes: 0, waiter: null, ended: false, worker: null };
  const fail = error => { diagnostic(error); entry.ended = true; entry.waiter?.(null); entry.waiter = null; };
  entry.worker = worker(new URL('./engine-worker.mjs', import.meta.url), message => {
    if (message.type === 'line') {
      if (typeof message.line !== 'string' || encoder.encode(message.line).byteLength > 16 * 1024 * 1024) { fail('Invalid engine frame'); engineStop(handle); return; }
      if (entry.waiter) { const resolve = entry.waiter; entry.waiter = null; resolve(message.line); }
      else {
        entry.bytes += encoder.encode(message.line).byteLength;
        if (entry.bytes > 32 * 1024 * 1024) { fail('Engine output queue limit exceeded'); engineStop(handle); return; }
        entry.queue.push(message.line);
      }
    } else if (message.type === 'diagnostic') diagnostic(message.text);
    else if (message.type === 'exit') { entry.ended = true; if (!entry.queue.length) { entry.waiter?.(null); entry.waiter = null; } }
    else if (message.type === 'fatal') fail(message.message);
  }, fail);
  engines.set(handle, entry);
  entry.worker.post({ type: 'start', base: new URL('./', import.meta.url).href, manifest, args });
  return handle;
}
async function acquireStore(name) {
  if (inNode || !globalThis.navigator?.locks || !globalThis.indexedDB) throw Error('Persistent WASM storage requires IndexedDB and Web Locks in a secure browser context');
  let ready, reject;
  const acquired = new Promise((resolve, bad) => { ready = resolve; reject = bad; });
  const lifetime = new Promise(resolve => { releaseLock = resolve; });
  navigator.locks.request(`neonethack:v1:${name}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) { reject(Error('Another worker or tab owns this WASM store')); return; }
    ready();
    await lifetime;
  }).catch(reject);
  await acquired;
}
async function initialize(options) {
  if (booted) throw Error('WASM runtime is already initialized');
  booted = true;
  storage = options.storage ?? { kind: 'memory' };
  if (storage.kind !== 'memory' && storage.kind !== 'indexeddb') throw Error('Unknown WASM storage kind');
  if (storage.kind === 'indexeddb') {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(storage.name ?? '')) throw Error('Storage name must be 1..64 ASCII letters, digits, underscores or hyphens');
    await acquireStore(storage.name);
  }
  const base = new URL('./', import.meta.url);
  manifest = await loadManifest(base);
  const [wasmBinary] = await Promise.all([checked(base, 'neonethack-core.wasm', manifest), checked(base, 'neonethack-core.mjs', manifest)]);
  globalThis.__nnhHost = {
    identity: `neonethack-wasm-build-v1:${manifest.buildId}\n`,
    diagnostic,
    persistence: storage.kind,
    async sync() {
      if (storage.kind !== 'indexeddb') return;
      await store.sync();

    },
    start: startEngine,
    write(handle, line) {
      const entry = engines.get(handle);
      if (!entry || entry.ended) return false;
      entry.worker.post({ type: 'line', line }); return true;
    },
    read(handle, timeout) {
      const entry = engines.get(handle);
      if (!entry) return Promise.resolve(null);
      if (entry.queue.length) {
        const line = entry.queue.shift(); entry.bytes -= encoder.encode(line).byteLength;
        return Promise.resolve(line);
      }
      if (entry.ended) return Promise.resolve(null);
      return new Promise(resolve => {
        const timer = timeout < 0 ? null : setTimeout(() => { entry.waiter = null; resolve(null); }, timeout);
        entry.waiter = line => { if (timer !== null) clearTimeout(timer); resolve(line); };
      });
    },
    ended: handle => !engines.has(handle) || engines.get(handle).ended,
    stop: engineStop,
  };
  const { default: factory } = await import(new URL('neonethack-core.mjs', base));
  module = await factory({ wasmBinary, print: diagnostic, printErr: diagnostic, onAbort: diagnostic });
  const fs = module.FS;
  const sessions = storage.kind === 'indexeddb' ? `/neonethack/${storage.name}` : '/sessions';
  fs.mkdirTree(sessions);
  if (storage.kind === 'indexeddb') {
    let seed;
    if (typeof storage.replicaUrl === 'string' && storage.replicaUrl) {
      try {
        const remote = await fetch(storage.replicaUrl);
        if (remote.ok) {
          seed = await remote.json();
          if (typeof seed.revision !== 'string') throw Error('Invalid cloud journal revision');
          replicaRevision = seed.revision;
          replicaFiles = JSON.stringify(seed.files);
          replicaKnown = new Set(seed.blocks.map(([id]) => id));
        } else if (remote.status !== 404) throw Error('Cannot read the cloud journal');
      } catch (error) { throw Error(`Cannot restore cloud journal: ${error}`); }
    }
    store = await openBlockStore(module, sessions, storage.name, seed);
    if (storage.replicaUrl) {
      let cursor = await store.replicaCursor();
      const pending = await store.replicaOutbox();
      if (pending && pending.commit === replicaRevision) {
        // The cloud accepted this exact durable upload before the browser lost its acknowledgement.
        await store.replicaCursor(replicaRevision, pending.files);
        await store.replicaOutbox(null);
        cursor = replicaRevision;
      }
      if (cursor !== replicaRevision) throw Error('The cloud journal is newer than this browser copy. Local progress was not overwritten. Open the bookmark in a fresh browser to resume the cloud copy.');
    }
  }
  fs.mkdir('/template');
  fs.writeFile('/engine-build', globalThis.__nnhHost.identity, { mode: 0o700 });
  const status = await module.ccall('nnh_wasm_open', 'number', ['string', 'string', 'string'], ['/engine-build', '/template', sessions], { async: true });
  if (status !== 0) throw Error(`Cannot open WASM world store (${status})`);
  return { buildId: manifest.buildId, persistence: storage.kind };
}
async function close() {
  try {
    requestActive = true;
    try { if (module) await module.ccall('nnh_wasm_close', null, [], [], { async: true }); }
    finally { requestActive = false; }
    if (storage?.replicaUrl && store) {
      queueReplica(); clearTimeout(replicaTimer);
      await replicaFlight;
      await uploadReplica();
      clearTimeout(replicaTimer);
    }
  } finally {
    for (const handle of engines.keys()) engineStop(handle);
    await Promise.allSettled(retirements);
    store?.close();
    releaseLock?.();
  }
}
listen(message => {
  tail = tail.then(async () => {
    let result;
    if (message.type === 'init') result = await initialize(message.options ?? {});
    else if (message.type === 'request') {
      if (!module) throw Error('WASM runtime has not been initialized');
      const json = JSON.stringify(message.request);
      if (encoder.encode(json).byteLength > 4096) throw Error('Request exceeds 4096 UTF-8 bytes');
      let response;
      requestActive = true;
      try { response = await module.ccall('nnh_wasm_request', 'string', ['string'], [json], { async: true }); }
      finally { requestActive = false; }
      queueReplica();
      if (!response) throw Error('WASM core could not allocate a result');
      result = JSON.parse(response);
    } else if (message.type === 'close') { await close(); result = {}; }
    else throw Error('Unknown worker message');
    send({ type: 'result', id: message.id, result });
  }).catch(async error => {
    diagnostic(error?.stack ?? error);
    await close().catch(diagnostic);
    send({ type: 'fatal', id: message.id, message: String(error) });
  });
});
