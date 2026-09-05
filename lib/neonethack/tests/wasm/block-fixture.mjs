// Test-only access to freshly created stores. Never used with local adventures.
export async function storedFile(page, name, path, replacement) {
  return page.evaluate(async ({ name, path, replacement }) => {
    const { databaseName, BLOCK_SIZE, encodeBlock, decodeBlock } = await import('/lib/neonethack/dist/wasm/block-store.mjs');
    const req = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const end = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
    const db = await req(indexedDB.open(databaseName(name)));
    try {
      const tx = db.transaction(['files', 'blocks'], 'readonly'), done = end(tx);
      const [paths, files, ids, blocks] = await Promise.all([
        req(tx.objectStore('files').getAllKeys()), req(tx.objectStore('files').getAll()),
        req(tx.objectStore('blocks').getAllKeys()), req(tx.objectStore('blocks').getAll()),
      ]);
      await done;
      const metadata = new Map(paths.map((p, i) => [p, files[i]])), data = new Map(ids.map((id, i) => [id, blocks[i]]));
      const entry = metadata.get(path);
      if (!entry) throw Error('Missing test artifact');
      const bytes = new Uint8Array(entry.size);
      for (let i = 0; i < entry.blocks.length; i++) bytes.set(await decodeBlock(entry.blocks[i], data.get(entry.blocks[i])), i * BLOCK_SIZE);
      if (replacement === undefined) return new TextDecoder().decode(bytes);
      const next = new TextEncoder().encode(replacement), additions = new Map();
      entry.size = next.length; entry.timestamp += 1000; entry.blocks = [];
      for (let i = 0; i < next.length; i += BLOCK_SIZE) {
        const block = next.slice(i, i + BLOCK_SIZE);
        const id = [...new Uint8Array(await crypto.subtle.digest('SHA-256', block))].map(b => b.toString(16).padStart(2, '0')).join('');
        additions.set(id, await encodeBlock(block)); entry.blocks.push(id);
      }
      const live = new Set([...metadata.values()].flatMap(e => e.blocks));
      const write = db.transaction(['files', 'blocks'], 'readwrite'), saved = end(write);
      write.objectStore('files').put(entry, path);
      for (const [id, block] of additions) write.objectStore('blocks').put(block, id);
      for (const id of ids) if (!live.has(id)) write.objectStore('blocks').delete(id);
      await saved;
      return replacement;
    } finally { db.close(); }
  }, { name, path, replacement });
}
