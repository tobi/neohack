// Opaque filesystem persistence. No game rules or receipt interpretation lives
// here. Every sync commits changed file headers and compressed blocks atomically.
export const BLOCK_SIZE = 64 * 1024;
export const databaseName = name => `/neonethack/${name}`;
const hashPattern = /^[a-f0-9]{64}$/;
const fields = (value, names) => value && typeof value === 'object' &&
  Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
  .map(b => b.toString(16).padStart(2, '0')).join('');
const request = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const committed = tx => new Promise((resolve, reject) => {
  tx.oncomplete = resolve;
  tx.onabort = () => reject(tx.error ?? Error('Storage transaction aborted'));
  tx.onerror = () => {}; // onabort is the final outcome, never request success.
});
const bytesOf = value => value instanceof Uint8Array ? value : new Uint8Array(value);
const b64encode = bytes => {
  const raw = bytesOf(bytes);
  let binary = '';
  for (let i = 0; i < raw.length; i += 8192) binary += String.fromCharCode(...raw.subarray(i, i + 8192));
  return btoa(binary);
};
const b64decode = text => {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

export async function encodeBlock(bytes) {
  const compressed = new Uint8Array(await new Response(
    new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')),
  ).arrayBuffer());
  return { version: 1, size: bytes.length, codec: compressed.length < bytes.length ? 'gzip' : 'raw',
    data: compressed.length < bytes.length ? compressed : bytes.slice() };
}
export async function decodeBlock(id, block) {
  if (typeof id !== 'string' || !hashPattern.test(id) ||
      !fields(block, ['version', 'size', 'codec', 'data']) || block.version !== 1 ||
      !Number.isInteger(block.size) || block.size < 1 || block.size > BLOCK_SIZE ||
      !(block.data instanceof Uint8Array) || block.data.length > BLOCK_SIZE ||
      !['gzip', 'raw'].includes(block.codec)) throw Error('Invalid compressed storage block');
  let bytes;
  if (block.codec === 'raw') bytes = block.data;
  else {
    // Bound decompression before allocation; a damaged header is not permission
    // to inflate an arbitrary-sized stream or accept a truncated gzip trailer.
    bytes = new Uint8Array(block.size);
    const reader = new Blob([block.data]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
    let length = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (length + value.length > bytes.length) throw Error('Storage block exceeds declared size');
        bytes.set(value, length); length += value.length;
      }
      if (length !== bytes.length) throw Error('Truncated storage block');
    } finally { await reader.cancel().catch(() => {}); }
  }
  if (bytes.length !== block.size || await hash(bytes) !== id) throw Error('Storage block checksum mismatch');
  return bytes;
}

export async function openBlockStore(module, mountpoint, name, seed) {
  if (!globalThis.CompressionStream || !globalThis.DecompressionStream)
    throw Error('Persistent WASM storage requires browser gzip streams');
  const fs = module.FS;
  const states = new WeakMap();
  let clock = Date.now(), db, files = new Map(), liveBlocks = new Set(), failed;
  const dirty = (node, start, end) => {
    const state = states.get(node);
    for (let i = Math.floor(start / BLOCK_SIZE); i < Math.ceil(end / BLOCK_SIZE); i++) state.dirty.add(i);
    // Also protect the C driver's stat-based integrity caches within one ms.
    node.mtime = node.ctime = clock = Math.max(Date.now(), clock + 1);
  };
  const watch = node => {
    const state = { dirty: new Set(), blocks: [] };
    states.set(node, state);
    const ops = node.node_ops;
    node.node_ops = { ...ops };
    if (ops.mknod) node.node_ops.mknod = (...args) => watch(ops.mknod(...args));
    if (ops.setattr) node.node_ops.setattr = (node, attr) => {
      const previousSize = node.usedBytes ?? 0;
      ops.setattr(node, attr);
      if (attr.size !== undefined && attr.size !== previousSize)
        dirty(node, Math.min(previousSize, attr.size), Math.max(previousSize, attr.size));
    };
    const stream = node.stream_ops;
    if (stream.write) node.stream_ops = { ...stream, write(...args) {
      const start = Math.min(args[4], args[0].node.usedBytes);
      const n = stream.write(...args);
      if (n > 0) dirty(args[0].node, start, args[4] + n);
      return n;
    } };
    if (stream.msync) node.stream_ops.msync = (...args) => {
      const start = Math.min(args[2], args[0].node.usedBytes);
      const result = stream.msync(...args);
      if (args[3] > 0) dirty(args[0].node, start, args[2] + args[3]);
      return result;
    };
    return node;
  };
  // MEMFS still supplies normal C file semantics, including atomic rename.
  fs.mount({ mount: mount => watch(module.MEMFS.mount(mount)) }, {}, mountpoint);
  try {
    const opening = indexedDB.open(databaseName(name), 23);
    opening.onupgradeneeded = () => {
      // Development stores are disposable. Replace obsolete schemas outright;
      // do not copy, decode or migrate their contents.
      for (const store of [...opening.result.objectStoreNames]) opening.result.deleteObjectStore(store);
      opening.result.createObjectStore('files');
      opening.result.createObjectStore('blocks');
      opening.result.createObjectStore('replica');
    };
    db = await request(opening);
    db.onversionchange = () => { failed = Error('Storage changed version while owned'); db.close(); };
    const tx = db.transaction(['files', 'blocks', 'replica'], 'readonly'), done = committed(tx);
    let [paths, headers, ids, blocks, cursor, acknowledged, outbox] = await Promise.all([
      request(tx.objectStore('files').getAllKeys()), request(tx.objectStore('files').getAll()),
      request(tx.objectStore('blocks').getAllKeys()), request(tx.objectStore('blocks').getAll()),
      request(tx.objectStore('replica').get('revision')), request(tx.objectStore('replica').get('files')),
      request(tx.objectStore('replica').get('outbox')), done,
    ]);
    // Never replace damaged or unsynced local data while selecting a cloud head.
    const localDecoded = new Map();
    for (let i = 0; i < ids.length; i++) localDecoded.set(ids[i], await decodeBlock(ids[i], blocks[i]));
    const localReferences = new Set(headers.flatMap(entry => entry.blocks ?? []));
    if (localReferences.size !== ids.length || ids.some(id => !localReferences.has(id))) throw Error("Unreferenced or missing local storage blocks; store was not repaired");
    let installSeed = false;
    if (seed) {
      if (seed.version !== 1 || !Array.isArray(seed.files) || !Array.isArray(seed.blocks)) throw Error('Invalid cloud replica');
      const current = paths.map((path, i) => [path, headers[i]]);
      const unchanged = acknowledged && JSON.stringify(current) === JSON.stringify(acknowledged);
      installSeed = !paths.length || (cursor !== seed.revision && outbox?.commit !== seed.revision && unchanged);
      if (installSeed) {
        if (seed.files.some(entry => !Array.isArray(entry) || entry.length !== 2) || seed.blocks.some(entry => !Array.isArray(entry) || entry.length !== 2)) throw Error('Invalid cloud replica entries');
        paths = seed.files.map(([path]) => path); headers = seed.files.map(([, header]) => header);
        ids = seed.blocks.map(([id]) => id);
        if (new Set(paths).size !== paths.length || new Set(ids).size !== ids.length) throw Error('Duplicate cloud replica entries');
        blocks = seed.blocks.map(([, block]) => {
          if (!fields(block, ['version', 'size', 'codec', 'data']) || typeof block.data !== 'string') throw Error('Invalid cloud replica block');
          return { ...block, data: b64decode(block.data) };
        });
      }
    }
    const decoded = installSeed ? new Map() : localDecoded;
    // Validate all blocks (including unexpected orphans) before populating MEMFS.
    if (installSeed) for (let i = 0; i < ids.length; i++) decoded.set(ids[i], await decodeBlock(ids[i], blocks[i]));
    const restored = new Map();
    for (let i = 0; i < paths.length; i++) {
      const path = paths[i], entry = headers[i];
      if (typeof path !== 'string' || !path.startsWith(mountpoint + '/') ||
          path.slice(mountpoint.length + 1).split('/').some(p => !p || p === '.' || p === '..') ||
          path.includes('\0') || !fields(entry, ['version', 'mode', 'timestamp', 'size', 'blocks']) ||
          entry.version !== 1 || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0xffff ||
          !Number.isSafeInteger(entry.timestamp) || entry.timestamp < 0 || entry.timestamp > 8640000000000000 ||
          !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 0xffffffff ||
          !Array.isArray(entry.blocks) || !entry.blocks.every(id => typeof id === 'string' && hashPattern.test(id)) ||
          (!fs.isFile(entry.mode) && !fs.isDir(entry.mode)) ||
          (fs.isDir(entry.mode) && (entry.size || entry.blocks.length)) ||
          (fs.isFile(entry.mode) && entry.blocks.length !== Math.ceil(entry.size / BLOCK_SIZE)))
        throw Error('Invalid compressed file manifest');
      const parent = path.slice(0, path.lastIndexOf('/'));
      restored.set(path, { entry, parent });
      for (let j = 0; j < entry.blocks.length; j++) {
        const id = entry.blocks[j], bytes = decoded.get(id);
        if (!bytes || bytes.length !== Math.min(BLOCK_SIZE, entry.size - j * BLOCK_SIZE))
          throw Error('Missing or mis-sized storage block');
        liveBlocks.add(id);
      }
      clock = Math.max(clock, entry.timestamp);
    }
    if (liveBlocks.size !== decoded.size) throw Error('Unreferenced storage blocks; store was not repaired');
    for (const [path, { entry, parent }] of [...restored].sort(([a], [b]) => a.localeCompare(b))) {
      if (parent !== mountpoint && !fs.isDir(restored.get(parent)?.entry.mode ?? 0))
        throw Error('Missing storage directory');
      if (fs.isDir(entry.mode)) fs.mkdir(path, entry.mode);
      else {
        const stream = fs.open(path, 'w', entry.mode);
        try { for (const id of entry.blocks) { const bytes = decoded.get(id); fs.write(stream, bytes, 0, bytes.length); } }
        finally { fs.close(stream); }
      }
      fs.chmod(path, entry.mode);
      fs.utime(path, entry.timestamp, entry.timestamp);
      const node = fs.lookupPath(path).node, state = states.get(node);
      state.blocks = entry.blocks; state.dirty.clear();
      files.set(path, entry);
    }
    if (installSeed) {
      // All hashes, manifests and directory references were checked above.
      const tx = db.transaction(['files', 'blocks', 'replica'], 'readwrite', { durability: 'strict' });
      const done = committed(tx);
      try {
        const metadata = tx.objectStore('files'), data = tx.objectStore('blocks'), replica = tx.objectStore('replica');
        metadata.clear(); data.clear(); replica.clear();
        paths.forEach((path, i) => metadata.put(headers[i], path));
        ids.forEach((id, i) => data.put(blocks[i], id));
        if (seed.revision) {
          replica.put(seed.revision, 'revision');
          replica.put(paths.map((path, i) => [path, headers[i]]), 'files');
        }
      } catch (error) { tx.abort(); await done.catch(() => {}); throw error; }
      await done;
    }
  } catch (error) { db?.close(); throw error; }

  async function sync() {
    if (failed) throw failed;
    try {
      const next = new Map(), updates = [], pendingBlocks = new Map(), completedNodes = [];
      const paths = fs.readdir(mountpoint).filter(p => p !== '.' && p !== '..').map(p => `${mountpoint}/${p}`);
      while (paths.length) {
        const path = paths.pop(), node = fs.lookupPath(path).node, stat = fs.lstat(path), state = states.get(node);
        if (!state || (!fs.isFile(stat.mode) && !fs.isDir(stat.mode))) throw Error('Unsupported persistent file');
        const entry = { version: 1, mode: stat.mode, timestamp: stat.mtime.getTime(), size: 0, blocks: [] };
        if (fs.isDir(stat.mode)) {
          paths.push(...fs.readdir(path).filter(p => p !== '.' && p !== '..').map(p => `${path}/${p}`));
        } else {
          entry.size = stat.size;
          const count = Math.ceil(stat.size / BLOCK_SIZE);
          entry.blocks = state.blocks.slice(0, count);
          // Writes/truncations mark blocks through MEMFS operations. An append
          // never scans/hashes/compresses the unchanged prefix of a large file.
          for (let i = 0; i < count; i++) {
            if (entry.blocks[i] && !state.dirty.has(i)) continue;
            const bytes = node.contents.subarray(i * BLOCK_SIZE, Math.min(stat.size, (i + 1) * BLOCK_SIZE));
            const id = await hash(bytes);
            entry.blocks[i] = id;
            if (!liveBlocks.has(id) && !pendingBlocks.has(id)) pendingBlocks.set(id, await encodeBlock(bytes));
          }
        }
        next.set(path, entry);
        if (JSON.stringify(files.get(path)) !== JSON.stringify(entry)) updates.push([path, entry]);
        completedNodes.push([state, entry]);
      }
      const nextBlocks = new Set([...next.values()].flatMap(entry => entry.blocks));
      const removed = [...files.keys()].filter(path => !next.has(path));
      const unused = [...liveBlocks].filter(id => !nextBlocks.has(id));
      if (updates.length || removed.length || pendingBlocks.size || unused.length) {
        // Compression finishes before opening the transaction. IndexedDB may
        // auto-commit across an unrelated await; queue all writes synchronously.
        const tx = db.transaction(['files', 'blocks'], 'readwrite', { durability: 'strict' });
        const done = committed(tx);
        try {
          const metadata = tx.objectStore('files'), data = tx.objectStore('blocks');
          for (const [id, block] of pendingBlocks) data.put(block, id);
          for (const [path, entry] of updates) metadata.put(entry, path);
          for (const path of removed) metadata.delete(path);
          for (const id of unused) data.delete(id);
        } catch (error) { tx.abort(); await done.catch(() => {}); throw error; }
        await done;
      }
      // Publish caches and reclaim obsolete blocks only with the committed
      // transaction. Failure poisons the owner; a later close must not retry it.
      files = next; liveBlocks = nextBlocks;
      for (const [state, entry] of completedNodes) {
        state.blocks = entry.blocks; state.dirty.clear();
      }
    } catch (error) { failed = error; throw error; }
  }
  async function snapshot(known = new Set()) {
    if (failed) throw failed;
    // Immutable committed headers let us fetch only new blocks, never copy the
    // full historical payload just to discover that most hashes are unchanged.
    const manifests = [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const ids = [...new Set(manifests.flatMap(([, entry]) => entry.blocks))].filter(id => !known.has(id));
    const tx = db.transaction('blocks', 'readonly'), done = committed(tx);
    const blocks = await Promise.all(ids.map(id => request(tx.objectStore('blocks').get(id))));
    await done;
    return {
      version: 1,
      files: manifests,
      blocks: ids.map((id, i) => {
        const block = blocks[i];
        if (!block) throw Error('Missing committed replica block');
        return [id, { version: block.version, size: block.size, codec: block.codec, data: b64encode(block.data) }];
      }),
    };
  }
  async function replicaBranch() {
    const tx=db.transaction('replica','readwrite',{durability:'strict'}),done=committed(tx),data=tx.objectStore('replica');
    const [branch,outbox,revision,acknowledged]=await Promise.all(['branch','outbox','revision','files'].map(k=>request(data.get(k))));
    if(branch){await done;if(typeof branch!=="string"||!/^[-a-f0-9]{36}$/i.test(branch))throw Error("Invalid backup stream identity");return branch;}
    const id=crypto.randomUUID();
    // Preserve the previous cloud acknowledgement and uncertain upload intact.
    // Start a full backup in a new stream; never rewrite the old cloud head.
    data.put({outbox,revision,files:acknowledged},'previous-copy');
    data.put(id,'branch');data.put(null,'revision');data.put([],'files');data.delete('outbox');
    await done;return id;
  }
  async function replicaAcknowledged() {
    const tx=db.transaction("replica","readonly"),done=committed(tx);
    const files=await request(tx.objectStore("replica").get("files"));await done;return files ?? [];
  }
  async function replicaCursor(revision, acknowledgedFiles) {
    const tx = db.transaction('replica', revision === undefined ? 'readonly' : 'readwrite', { durability: 'strict' });
    const done = committed(tx);
    if (revision !== undefined) tx.objectStore('replica').put(revision, 'revision');
    if (acknowledgedFiles) tx.objectStore('replica').put(acknowledgedFiles, 'files');
    const value = await request(tx.objectStore('replica').get('revision'));
    await done;
    return value ?? null;
  }
  async function replicaOutbox(value) {
    const tx = db.transaction('replica', value === undefined ? 'readonly' : 'readwrite', { durability: 'strict' });
    const done = committed(tx), outbox = tx.objectStore('replica');
    if (value === null) outbox.delete('outbox');
    else if (value !== undefined) outbox.put(value, 'outbox');
    const result = await request(outbox.get('outbox'));
    await done;
    return result ?? null;
  }
  return { sync, snapshot, replicaCursor, replicaAcknowledged, replicaBranch, replicaOutbox, close() { db.close(); } };
}
