import { fetchCloudReplica } from './cloud-replica.mjs';
import { ReplicaUploader } from './replica-uploader.mjs';
import { listen, send, worker, inNode } from './worker-port.mjs';
import { loadManifest, checked } from './assets.mjs';
import { openBlockStore } from './block-store.mjs';
let module, manifest, storage, releaseLock, store, runtimeBase;
let booted = false;
let requestActive = false, replica, replicaRevision = null, replicaFiles = [];
const queueReplica = () => replica?.queue();

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
  entry.worker.post({ type: 'start', base: runtimeBase.href, manifest, args });
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
  const base = runtimeBase = new URL(options.runtimeUrl ?? './', import.meta.url);
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
  let replicaBranch;
  const sessions = storage.kind === 'indexeddb' ? `/neonethack/${storage.name}` : '/sessions';
  fs.mkdirTree(sessions);
  if (storage.kind === 'indexeddb') {
    let seed, remoteAvailable = false;
    if (typeof storage.replicaUrl === 'string' && storage.replicaUrl && storage.replicaRestore !== false) {
      try {
seed = await fetchCloudReplica(storage.replicaUrl);
if (seed) {
  replicaRevision = seed.revision;
  replicaFiles = seed.files;
}
        remoteAvailable = true;
      } catch { seed = undefined; replicaRevision = null; replicaFiles = []; }
    }
    store = await openBlockStore(module, sessions, storage.name, seed);
    if (storage.replicaUrl && !remoteAvailable) {
      // Local journals remain authoritative when the network is unavailable.
      // Keep the acknowledged base and exact outbox; server CAS still rejects forks.
      replicaRevision = await store.replicaCursor();
    }
    if (storage.replicaUrl && remoteAvailable) {
      let cursor = await store.replicaCursor();
      const pending = await store.replicaOutbox();
      if (pending && pending.commit === replicaRevision) {
        // The cloud accepted this exact durable upload before the browser lost its acknowledgement.
        await store.replicaCursor(replicaRevision, pending.files);
        await store.replicaOutbox(null);
        cursor = replicaRevision;
      }
      replicaRevision = cursor;
    }
    if(storage.replicaBranches) {
      replicaBranch=await store.replicaBranch();
      replicaRevision=await store.replicaCursor();
    }
    replicaFiles=await store.replicaAcknowledged();
  }
  if (storage.replicaUrl && store) {
    const url=new URL(storage.replicaUrl);
    if(replicaBranch)url.searchParams.set('branch',replicaBranch);
    replica = new ReplicaUploader({store,url:url.href,revision:replicaRevision,files:replicaFiles,
      active:()=>requestActive,status:(state,message='')=>send({type:'replica',state,message,branch:replicaBranch,sessions:state==='saved'?replica.files.filter(([p])=>p.split('/').length===5&&p.endsWith('/meta.json')).map(([p])=>p.split('/')[3]):undefined})});
    replica.queue();
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
      queueReplica();
      await replica?.close();
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
