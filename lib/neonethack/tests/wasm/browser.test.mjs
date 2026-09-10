import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { storedFile } from './block-fixture.mjs';
import { serveExample } from '../../scripts/serve-example.mjs';
async function fixture(t, packageDirectory) {
  const server = await serveExample();
  if (packageDirectory) {
    // Real HTTP delivery also covers nested Worker startup, which browser
    // request interception does not consistently handle.
    const original = server.listeners('request')[0];
    server.removeAllListeners('request');
    server.on('request', async (req,res) => {
      const path=new URL(req.url,'http://localhost').pathname;
      if (!path.startsWith('/__manual_fixture__/')) return original(req,res);
      const name=path.slice('/__manual_fixture__/'.length);
      if (!/^[\w.-]+$/.test(name) || !['GET','HEAD'].includes(req.method)) {res.writeHead(404).end();return;}
      try {
        const data=await readFile(packageDirectory+'/'+name);
        res.setHeader('Content-Type',name.endsWith('.mjs')?'text/javascript':name.endsWith('.json')?'application/json':name.endsWith('.wasm')?'application/wasm':'application/octet-stream');
        res.setHeader('Content-Length',data.length);
        res.end(req.method==='HEAD'?undefined:data);
      } catch {res.writeHead(404).end();}
    });
  }
  let browser;
  t.after(async () => {
    // Hooks run in registration order. Waiting for HTTP shutdown before closing
    // Chromium can deadlock on a cancelled/partial browser request, hiding even
    // test timeouts. Retire the client first and bound server connection cleanup.
    try { await browser?.close(); }
    finally {
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    }
  });
  const executablePath = process.env.CHROMIUM ?? (await access('/usr/bin/chromium').then(() => '/usr/bin/chromium', () => undefined));
  browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(String(error)));
  const methods = []; page.on('request', req => methods.push(req.method()));
  const url = `http://127.0.0.1:${server.address().port}/examples/wasm/index.html`;
  await page.goto(url);
  t.after(async () => { if (errors.length) t.diagnostic(errors.join('\n')); });
  return { page, url, errors, methods, server };
}
const frame = async page => JSON.parse(await page.locator('#frame').textContent());
async function waitFrame(page, predicate) {
  await page.waitForFunction(predicate);
  return frame(page);
}
const frameExpression = `JSON.parse(document.querySelector('neonethack-example').shadowRoot.querySelector('#frame').textContent || '{}')`;

test('browser fixture teardown closes partial HTTP connections without hiding results', { timeout: 15000 }, async t => {
  let socket, closed;
  t.after(() => socket?.destroy());
  await t.test('an unfinished request remains open until fixture teardown', async child => {
    const { url } = await fixture(child);
    socket = createConnection({ host: '127.0.0.1', port: Number(new URL(url).port) });
    await once(socket, 'connect');
    // HTTP parsing is deliberately unfinished. Closing only idle keep-alive
    // connections is insufficient; no request handler can finish this response.
    socket.on('error', () => {}); // A reset on shutdown is also a closed socket.
    closed = new Promise(resolve => socket.once('close', resolve));
    socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n');
  });
  await closed;
  assert.equal(socket.destroyed, true);
});

test('actual browser example plays, preserves consent across reload, and sends no game HTTP traffic', { timeout: 60_000 }, async t => {
  const { page, errors, methods } = await fixture(t);
  await page.getByRole('button', { name: 'New world', exact: true }).click();
  const first = await waitFrame(page, `${frameExpression}.observation?.turn === 1`);
  assert.ok((await page.locator('#map').textContent()).includes('@'));
  await page.getByRole('button', { name: 'Wait', exact: true }).click();
  await waitFrame(page, `${frameExpression}.observation?.turn === 2`);
  await page.getByRole('button', { name: 'Eat', exact: true }).click();
  await waitFrame(page, `${frameExpression}.decision?.kind === 'item'`);
  await page.getByRole('button', { name: 'Cancel choice', exact: true }).click();
  await waitFrame(page, `${frameExpression}.decision === null`);
  await page.getByRole('button', { name: 'Pray', exact: true }).click();
  const prayer = await waitFrame(page, `${frameExpression}.decision?.kind === 'confirmation'`);
  await page.getByRole('button', { name: 'Retire', exact: true }).click();
  await page.getByRole('button', { name: 'Resume', exact: true }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  const restored = await waitFrame(page, `${frameExpression}.decision?.kind === 'confirmation'`);
  assert.equal(restored.sessionId, first.sessionId);
  assert.deepEqual(restored.observation, prayer.observation);
  assert.deepEqual(restored.decision, prayer.decision);
  await page.getByRole('button', { name: 'No', exact: true }).click();
  const declined = await waitFrame(page, `${frameExpression}.decision === null`);
  assert.equal(declined.observation.turn, prayer.observation.turn);
  await page.getByRole('button', { name: 'Pray', exact: true }).click();
  await waitFrame(page, `${frameExpression}.decision?.kind === 'confirmation'`);
  await page.getByRole('button', { name: 'Cancel choice', exact: true }).click();
  const cancelled = await waitFrame(page, `${frameExpression}.decision === null`);
  assert.equal(cancelled.outcome.status, 'cancelled');
  assert.equal(cancelled.observation.turn, prayer.observation.turn);
  assert.ok(!cancelled.observation.heard.some(text => /Program in disorder|yn_function\(\) returned|report these messages/.test(text)));
  assert.deepEqual(errors, []);
  assert.ok(methods.length > 0 && methods.every(method => method === 'GET'));
});

test('IndexedDB commits survive worker loss, exclude a competing owner and retain exact receipts', { timeout: 60_000 }, async t => {
  const { page, errors } = await fixture(t);
  const saved = await page.evaluate(async () => {
    const { createWasm } = await import('/lib/neonethack/dist/typescript/wasm.js');
    const options = { storage: { kind: 'indexeddb', name: 'contract' } };
    const api = await createWasm(options);
    globalThis.contractApi = api;
    const info = await api.describe();
    const game = await api.create({ name: 'Durable', seed: 42, role: 'valkyrie', race: 'dwarf', gender: 'female', align: 'lawful' });
    let competing;
    try { await createWasm(options); } catch (error) { competing = String(error); }
    const request = { version: 1, method: 'game.wait', params: { sessionId: game.id, requestId: 'durable-wait', expectedRevision: game.state.revision } };
    const receipt = await api.transport.send(request);
    await game.observe();
    const prayer = await game.pray();
    return { info, competing, request, receipt, prayer };
  });
  assert.equal(saved.info.capabilities.durability, 'indexeddb-transaction');
  assert.match(saved.competing, /owns this WASM store/);
  // Destroy the owner without close. Every returned input/receipt boundary must
  // already be committed; a later unload handler is not the persistence plan.
  await page.reload();
  const restored = await page.evaluate(async saved => {
    const { createWasm } = await import('/lib/neonethack/dist/typescript/wasm.js');
    const api = await createWasm({ storage: { kind: 'indexeddb', name: 'contract' } });
    try {
      const game = await api.resume(saved.prayer.sessionId);
      const state = game.state;
      const receipt = await api.transport.send(saved.request);
      const current = await game.observe();
      return { state, receipt, current };
    } finally { await api.close(); }
  }, saved);
  assert.deepEqual(restored.state.observation, saved.prayer.observation);
  assert.deepEqual(restored.state.decision, saved.prayer.decision);
  assert.deepEqual(restored.receipt, saved.receipt);
  assert.deepEqual(restored.current.observation, saved.prayer.observation);
  assert.deepEqual(errors, []);
});

test('WASM refuses another build pin and a torn input journal without rewriting either', { timeout: 60_000 }, async t => {
  const { page } = await fixture(t), results = [];
  for (const damage of ['engine', 'input.log.jsonl']) {
    const name = damage === 'engine' ? 'wrong-build' : 'torn-input';
    const id = await page.evaluate(async name => {
      const { createWasm } = await import('/lib/neonethack/dist/typescript/wasm.js');
      const api = await createWasm({ storage: { kind: 'indexeddb', name } });
      const game = await api.create({ name: 'Integrity', seed: 42, role: 'valkyrie', race: 'dwarf', gender: 'female', align: 'lawful' });
      await game.wait(); await api.close(); return game.id;
    }, name);
    const path = '/neonethack/' + name + '/' + id + '/' + damage;
    const original = await storedFile(page, name, path);
    const damaged = damage === 'engine' ? 'neonethack-wasm-build-v1:' + '0'.repeat(64) + '\n' : original + '{';
    await storedFile(page, name, path, damaged);
    const error = await page.evaluate(async ({ name, id }) => {
      const { createWasm } = await import('/lib/neonethack/dist/typescript/wasm.js');
      const api = await createWasm({ storage: { kind: 'indexeddb', name } });
      try { return (await api.request('session.resume', { sessionId: id })).error; }
      finally { await api.close(); }
    }, { name, id });
    results.push({ damage, error, unchanged: await storedFile(page, name, path) === damaged });
  }
  assert.equal(results[0].error.code, 'runtimeUnavailable');
  assert.equal(results[1].error.code, 'inputHistoryError');
  assert.ok(results.every(result => result.unchanged));
});

test('IndexedDB door witness, exact lost receipt and free query survive abrupt browser reload', { timeout: 60_000 }, async t => {
  const {page,errors}=await fixture(t);
  const saved=await page.evaluate(async()=> {
    const {createWasm}=await import('/lib/neonethack/dist/typescript/wasm.js');
    const api=await createWasm({storage:{kind:'indexeddb',name:'door-evidence'}}); globalThis.doorApi=api;
    const game=await api.create({name:'Door',seed:24,role:'valkyrie',race:'human',gender:'female',align:'lawful'});
    for(let i=0;i<8;i++) await game.move('east');
    const before=await game.actions({direction:'east'});
    const request={version:1,method:'game.move',params:{sessionId:game.id,requestId:'door-lost',expectedRevision:game.state.revision,direction:'east'}};
    // The transport's reply is withheld from Game, as if it had been lost.
    const receipt=await api.transport.send(request); await game.observe();
    const known=await game.actions({direction:'east'}), timings=[];
    for(let i=0;i<50;i++) {const start=performance.now();await game.actions('here');timings.push(performance.now()-start);}
    return {before,receipt,request,known,p95:timings.sort((a,b)=>a-b)[47]};
  });
  assert.equal(saved.before.cell.door.lock,'unknown'); assert.equal(saved.known.cell.door.lock,'locked');
  assert.equal(saved.receipt.outcome.reason,'lockedDoor');
  t.diagnostic(`IndexedDB browser action query p95: ${saved.p95.toFixed(2)} ms`);
  await page.reload();
  const resumed=await page.evaluate(async saved=> {
    const {createWasm}=await import('/lib/neonethack/dist/typescript/wasm.js');
    const api=await createWasm({storage:{kind:'indexeddb',name:'door-evidence'}});
    try {const game=await api.resume(saved.receipt.sessionId);return {query:await game.actions({direction:'east'}),receipt:await api.transport.send(saved.request)};} finally {await api.close();}
  },saved);
  assert.deepEqual(resumed.query,saved.known); assert.deepEqual(resumed.receipt,saved.receipt); assert.deepEqual(errors,[]);
});

test('compressed browser walking has bounded writes and retains old receipts and warnings after abrupt reload', { timeout: 60_000 }, async t => {
  const { page, errors } = await fixture(t);
  await page.evaluate(async () => {
    const { createWasm } = await import('/lib/neonethack/dist/typescript/wasm.js');
    globalThis.walkApi = await createWasm({ storage: { kind: 'indexeddb', name: 'compact-walk' } });
    globalThis.walkGame = await walkApi.create({ name: 'Walking', seed: 42, role: 'valkyrie', race: 'dwarf', gender: 'female', align: 'lawful' });
  });
  const worker = page.workers().filter(worker => worker.url().endsWith('/core-worker.mjs')).at(-1);
  await worker.evaluate(() => {
    globalThis.written = { bytes: 0, blocks: 0, maximum: 0 };
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, ...args) {
      const bytes = this.name === 'blocks' ? value.data.byteLength : new TextEncoder().encode(JSON.stringify(value)).length;
      written.bytes += bytes; written.maximum = Math.max(written.maximum, bytes);
      if (this.name === 'blocks') written.blocks++;
      return put.call(this, value, ...args);
    };
  });
  const saved = await page.evaluate(async () => {
    const receipts = [], times = [];
    for (let i = 0; i < 80; i++) {
      const o = walkGame.observation, you = o.you;
      const direction = [['east', 1, 0], ['west', -1, 0], ['south', 0, 1], ['north', 0, -1]]
        .find(([, dx, dy]) => o.world.some(c => c.x === you.x + dx && c.y === you.y + dy && c.terrain.type === 'floor' && !c.occupant))?.[0];
      if (!direction) throw Error('No perceived walking step in engine scenario');
      const request = { version: 1, method: 'game.move', params: { sessionId: walkGame.id, requestId: `walking-${i}`, expectedRevision: walkGame.state.revision, direction } };
      const started = performance.now(), receipt = await walkApi.transport.send(request);
      times.push(performance.now() - started);
      if (receipt.error || !receipt.outcome.positionChanged) throw Error('Engine walking scenario did not advance');
      if ([0, 40, 79].includes(i)) receipts.push({ request, receipt });
      await walkGame.observe();
    }
    const prayer = await walkGame.pray();
    return { receipts, prayer, times };
  });
  const writes = await worker.evaluate(() => written);
  const sizes = await page.evaluate(async () => {
    const { databaseName } = await import('/lib/neonethack/dist/wasm/block-store.mjs');
    const req = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const db = await req(indexedDB.open(databaseName('compact-walk')));
    try {
      const tx = db.transaction(['files', 'blocks'], 'readonly');
      const [files, blocks] = await Promise.all([req(tx.objectStore('files').getAll()), req(tx.objectStore('blocks').getAll())]);
      return { logical: files.reduce((n, e) => n + e.size, 0), physical: blocks.reduce((n, b) => n + b.data.byteLength, 0) };
    } finally { db.close(); }
  });
  assert.ok(sizes.physical < sizes.logical / 4, 'real engine files are stored compressed, not merely transmitted in smaller writes');
  t.diagnostic(`80 durable moves: median ${saved.times.toSorted((a, b) => a - b)[40].toFixed(1)} ms; last ${saved.times.at(-1).toFixed(1)} ms; ${(writes.bytes / 1024).toFixed(0)} KiB submitted including warning`);
  assert.ok(writes.blocks > 80, 'instrumentation observes actual compressed storage writes');
  assert.ok(writes.bytes < 5 * 1024 * 1024, '80 moves must not rewrite hundreds of MB of past receipts');
  assert.ok(writes.maximum <= 65536, 'individual stored blocks stay bounded');
  assert.equal(saved.prayer.decision.kind, 'confirmation');
  const base = `/neonethack/compact-walk/${saved.prayer.sessionId}`;
  assert.deepEqual(JSON.parse(await storedFile(page, 'compact-walk', `${base}/meta.json`)).requests, []);
  const history = await storedFile(page, 'compact-walk', `${base}/perceptions.jsonl`);
  assert.ok(history.length > 1024 * 1024, 'actual engine history spans many blocks');
  const input = await storedFile(page, 'compact-walk', `${base}/input.log.jsonl`);
  await page.reload(); // No close/unload flush can supply missing durability.
  const restored = await page.evaluate(async saved => {
    const { createWasm } = await import('/lib/neonethack/dist/typescript/wasm.js');
    const api = await createWasm({ storage: { kind: 'indexeddb', name: 'compact-walk' } });
    try {
      const game = await api.resume(saved.prayer.sessionId);
      const receipts = [];
      for (const entry of saved.receipts) receipts.push(await api.transport.send(entry.request));
      return { state: game.state, receipts };
    } finally { await api.close(); }
  }, saved);
  assert.deepEqual(restored.state.decision, saved.prayer.decision);
  assert.deepEqual(restored.state.observation, saved.prayer.observation);
  assert.deepEqual(restored.receipts, saved.receipts.map(entry => entry.receipt));
  assert.equal(await storedFile(page, 'compact-walk', `${base}/input.log.jsonl`), input);
  assert.ok((await storedFile(page, 'compact-walk', `${base}/perceptions.jsonl`)).startsWith(history), 'original journal bytes survive compaction and resume');
  assert.deepEqual(errors, []);
});

test('compressed MEMFS appends reuse prefixes; overwrite, holes, truncation and rename restore exact bytes', async t => {
  const { page } = await fixture(t);
  const result = await page.evaluate(async () => {
    const { default: factory } = await import('/lib/neonethack/dist/wasm/neonethack-core.mjs');
    const { openBlockStore, BLOCK_SIZE, databaseName } = await import('/lib/neonethack/dist/wasm/block-store.mjs');
    const module = await factory(), fs = module.FS, root = '/blocks'; fs.mkdir(root);
    let store = await openBlockStore(module, root, 'fs-blocks');
    const path = root + '/journal', bytes = new Uint8Array(BLOCK_SIZE * 3 + 17).fill(65);
    fs.writeFile(path, bytes); await store.sync();
    const read = async () => {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open(databaseName('fs-blocks')); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      try {
        const tx = db.transaction(['files', 'blocks'], 'readonly');
        const data = await new Promise((resolve, reject) => { const r = tx.objectStore('files').get(path); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
        return data;
      } finally { db.close(); }
    };
    const first = await read();
    const put = IDBObjectStore.prototype.put, written = [];
    IDBObjectStore.prototype.put = function(value, key) { if (this.name === 'blocks') written.push(key); return put.call(this, value, key); };
    let fd = fs.open(path, 'a'); fs.write(fd, new Uint8Array([66, 67]), 0, 2); fs.close(fd);
    await store.sync();
    const appended = await read(), appendWrites = [...written];
    IDBObjectStore.prototype.put = put;
    // In-place writes and growth beyond EOF must also invalidate the partial
    // old tail, including the zero-filled gap before a positioned write.
    fd = fs.open(path, 'r+'); fs.write(fd, new Uint8Array([90]), 0, 1, 3);
    fd.stream_ops.msync(fd, new Uint8Array([92]), 4, 1, 0);
    fs.write(fd, new Uint8Array([91]), 0, 1, BLOCK_SIZE * 4 + 3); fs.close(fd);
    await store.sync();
    const sparse = fs.readFile(path);
    fs.truncate(path, BLOCK_SIZE + 11); await store.sync();
    // Re-extend after shrinking without a sync between them: discarded content
    // must not be resurrected from a previously persisted block.
    fs.truncate(path, 9); fs.truncate(path, BLOCK_SIZE + 7);
    fs.rename(path, root + '/renamed'); await store.sync();
    const expected = fs.readFile(root + '/renamed');
    store.close(); fs.unmount(root);
    store = await openBlockStore(module, root, 'fs-blocks');
    const restored = fs.readFile(root + '/renamed');
    const same = expected.length === restored.length && expected.every((b, i) => b === restored[i]);
    const removed = !fs.analyzePath(path).exists;
    store.close();
    return { prefix: first.blocks.slice(0, 3), appended: appended.blocks.slice(0, 3), appendWrites,
      same, removed, size: restored.length, zeros: restored.slice(9).every(b => b === 0),
      sparse: sparse[3] === 90 && sparse[4] === 92 && sparse.at(-1) === 91 && sparse.slice(BLOCK_SIZE * 3 + 19, -1).every(b => b === 0) };
  });
  assert.deepEqual(result.prefix, result.appended);
  assert.equal(result.appendWrites.length, 1, 'append writes only one compressed tail, even with a multi-block prefix');
  assert.equal(result.size, 65536 + 7);
  assert.ok(result.same && result.removed && result.zeros && result.sparse);
});

for (const damage of ['missing', 'gzip', 'checksum', 'manifest']) {
  test(`compressed browser store rejects ${damage} corruption without rewriting it`, { timeout: 15000 }, async t => {
    const { page } = await fixture(t);
    const result = await page.evaluate(async damage => {
      const { createWasm } = await import('/lib/neonethack/dist/typescript/wasm.js');
      const { databaseName } = await import('/lib/neonethack/dist/wasm/block-store.mjs');
      const name = 'damaged-block-' + damage, options = { storage: { kind: 'indexeddb', name } };
      const api = await createWasm(options);
      const game = await api.create({ name: 'Integrity', seed: 42, role: 'valkyrie', race: 'dwarf', gender: 'female', align: 'lawful' });
      await game.move('east'); await api.close();
      const req = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      const end = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
      const db = await req(indexedDB.open(databaseName(name)));
      const tx = db.transaction(['files', 'blocks'], 'readonly'), done = end(tx);
      const [keys, blocks] = await Promise.all([req(tx.objectStore('blocks').getAllKeys()), req(tx.objectStore('blocks').getAll())]);
      await done;
      const i = blocks.findIndex(b => b.codec === 'gzip');
      if (i < 0) throw Error('Actual engine must produce compressed blocks');
      const id = keys[i], block = blocks[i];
      const write = db.transaction(['files', 'blocks'], 'readwrite'), saved = end(write);
      if (damage === 'missing') write.objectStore('blocks').delete(id);
      else if (damage === 'manifest') {
        const path = `/neonethack/${name}/${game.id}/meta.json`;
        const read = write.objectStore('files').get(path);
        read.onsuccess = () => { const entry = read.result; entry.blocks = ['0'.repeat(64)]; write.objectStore('files').put(entry, path); };
      } else {
        if (damage === 'gzip') block.data = block.data.slice(0, -4);
        else { block.codec = 'raw'; block.data = new Uint8Array(block.size).fill(88); }
        write.objectStore('blocks').put(block, id);
      }
      await saved;
      const snapshot = async () => {
        const tx = db.transaction(['files', 'blocks'], 'readonly'), done = end(tx);
        const values = await Promise.all([req(tx.objectStore('files').getAll()), req(tx.objectStore('blocks').getAll())]);
        await done; return JSON.stringify(values);
      };
      const before = await snapshot();
      let error = '';
      try { const bad = await createWasm(options); await bad.close(); } catch (e) { error = String(e); }
      const unchanged = before === await snapshot(); db.close();
      return { error, unchanged };
    }, damage);
    assert.match(result.error, /block|manifest|decompress|compressed|gzip/i);
    assert.equal(result.unchanged, true);
  });
}

test('aborted browser pre-input transaction sends no engine input and cannot be retried on close', async t => {
  const { page } = await fixture(t);
  const id = await page.evaluate(async () => {
    const { createWasm } = await import('/lib/neonethack/dist/typescript/wasm.js');
    globalThis.abortApi = await createWasm({ storage: { kind: 'indexeddb', name: 'abort-blocks' } });
    globalThis.abortGame = await abortApi.create({ name: 'Abort', seed: 42, role: 'valkyrie', race: 'dwarf', gender: 'female', align: 'lawful' });
    return abortGame.id;
  });
  const base = `/neonethack/abort-blocks/${id}`;
  const before = await storedFile(page, 'abort-blocks', `${base}/input.log.jsonl`);
  const worker = page.workers().filter(worker => worker.url().endsWith('/core-worker.mjs')).at(-1);
  await worker.evaluate(() => {
    globalThis.engineWrites = 0; globalThis.aborts = 0;
    const write = __nnhHost.write; __nnhHost.write = (...args) => { engineWrites++; return write(...args); };
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(...args) {
      const result = put.apply(this, args);
      if (!aborts && this.name === 'files') { aborts++; this.transaction.abort(); }
      return result;
    };
  });
  const response = await page.evaluate(async () => {
    const response = await abortApi.transport.send({ version: 1, method: 'game.move', params: { sessionId: abortGame.id, requestId: 'aborted-move', expectedRevision: abortGame.state.revision, direction: 'east' } });
    return response;
  });
  assert.ok(response.error || response.storage?.status === 'degraded');
  assert.deepEqual(await worker.evaluate(() => ({ engineWrites, aborts })), { engineWrites: 0, aborts: 1 });
  assert.equal(await storedFile(page, 'abort-blocks', `${base}/input.log.jsonl`), before);
  await page.evaluate(() => abortApi.close());
  assert.equal(await storedFile(page, 'abort-blocks', `${base}/input.log.jsonl`), before);
});

test('aborted block replacement preserves old manifests and blocks atomically and poisons further syncs', async t => {
  const { page } = await fixture(t);
  const result = await page.evaluate(async () => {
    const { default: factory } = await import('/lib/neonethack/dist/wasm/neonethack-core.mjs');
    const { openBlockStore } = await import('/lib/neonethack/dist/wasm/block-store.mjs');
    const module = await factory(), fs = module.FS, root = '/atomic'; fs.mkdir(root);
    let store = await openBlockStore(module, root, 'atomic-blocks');
    const original = new Uint8Array(70000).fill(65);
    fs.writeFile(root + '/file', original); await store.sync();
    fs.writeFile(root + '/file', new Uint8Array(90000).fill(66));
    fs.rename(root + '/file', root + '/replacement');
    const put = IDBObjectStore.prototype.put;
    let aborted = false, firstError = '', secondError = '';
    IDBObjectStore.prototype.put = function(value, key) {
      const r = put.call(this, value, key);
      // Blocks have already been queued by this point. Neither replacement nor
      // deletion of the previous blocks may survive an aborted transaction.
      if (!aborted && this.name === 'files') { aborted = true; this.transaction.abort(); }
      return r;
    };
    try { await store.sync(); } catch (e) { firstError = String(e); }
    IDBObjectStore.prototype.put = put;
    try { await store.sync(); } catch (e) { secondError = String(e); }
    store.close(); fs.unmount(root);
    store = await openBlockStore(module, root, 'atomic-blocks');
    const restored = fs.readFile(root + '/file');
    const same = restored.length === original.length && restored.every((b, i) => b === original[i]);
    const absent = !fs.analyzePath(root + '/replacement').exists;
    store.close(); return { aborted, firstError, secondError, same, absent };
  });
  assert.equal(result.aborted, true);
  assert.ok(result.firstError);
  assert.equal(result.secondError, result.firstError, 'failure cannot be hidden by a later successful sync');
  assert.ok(result.same && result.absent);
});

test('obsolete development storage is replaced with an empty current schema', async t => {
  const { page } = await fixture(t);
  const result = await page.evaluate(async () => {
    const { databaseName } = await import('/lib/neonethack/dist/wasm/block-store.mjs');
    const name = 'replace-obsolete';
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open(databaseName(name), 21);
      r.onupgradeneeded = () => r.result.createObjectStore('FILE_DATA');
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('FILE_DATA', 'readwrite');
      tx.objectStore('FILE_DATA').put('obsolete bytes are discarded, not decoded', '/old-save');
      tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
    });
    db.close();
    const { createWasm } = await import('/lib/neonethack/dist/typescript/wasm.js');
    const api = await createWasm({ storage: { kind: 'indexeddb', name } });
    try {
      const game = await api.create({ name: 'Fresh', seed: 42, role: 'valkyrie', race: 'dwarf', gender: 'female', align: 'lawful' });
      const moved = await game.move('east');
      const current = await new Promise((resolve, reject) => {
        const r = indexedDB.open(databaseName(name)); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
      });
      const stores = [...current.objectStoreNames], version = current.version; current.close();
      return { stores, version, turn: moved.observation.turn, positionChanged: moved.outcome.positionChanged };
    } finally { await api.close(); }
  });
  assert.deepEqual(result.stores, ['blocks', 'files', 'replica']);
  assert.equal(result.version, 23);
  assert.equal(result.turn, 2);
  assert.equal(result.positionChanged, true);
});

test('actual browser exposes both engine door frame axes and retains them on IndexedDB resume', { timeout: 60_000 }, async t => {
  const { page } = await fixture(t);
  const result = await page.evaluate(async () => {
    const { createWasm } = await import('/lib/neonethack/dist/typescript/wasm.js');
    const api = await createWasm({ storage: { kind: 'indexeddb', name: 'door-orientations' } });
    try {
      const doors = [];
      for (const [seed, race, path, direction] of [
        [42, 'dwarf', ['south', 'south', 'west', 'west'], 'south'],
        [24, 'human', Array(8).fill('east'), 'east'],
      ]) {
        let game = await api.create({ name: 'Orientation', seed, role: 'valkyrie', race, gender: 'female', align: 'lawful' });
        for (const step of path) await game.move(step);
        const query = await game.actions({ direction });
        const { x, y } = query.cell;
        const before = game.observation.world.find(c => c.x === x && c.y === y);
        await game.close(); game = await api.resume(game.id);
        const after = game.observation.world.find(c => c.x === x && c.y === y);
        doors.push({ query: query.cell.terrain, before: before.terrain, after: after.terrain });
        await game.close();
      }
      return doors;
    } finally { await api.close(); }
  });
  for (const [i, orientation] of ['horizontal', 'vertical'].entries()) {
    assert.equal(result[i].query.orientation, orientation);
    assert.equal(result[i].before.orientation, orientation);
    assert.deepEqual(result[i].before, result[i].after);
  }
});

test('browser manual throwing preserves item and target across reload; engraving retains explicit text', {timeout:60_000}, async t => {
  const {page,errors}=await fixture(t);
  await page.getByRole('button',{name:'New world',exact:true}).click();
  const initial=await waitFrame(page,`${frameExpression}.observation?.turn === 1`);
  await page.getByRole('button',{name:'Throw',exact:true}).click();
  const items=await waitFrame(page,`${frameExpression}.decision?.kind === 'item'`);
  const dagger=items.decision.options.find(i=>i.label.includes('dagger'));assert.ok(dagger);
  await page.getByRole('button',{name:dagger.label,exact:true}).click();
  const target=await waitFrame(page,`${frameExpression}.decision?.kind === 'target'`);
  await page.getByRole('button',{name:'Retire',exact:true}).click();await page.reload();
  await page.getByRole('button',{name:'Resume',exact:true}).click();
  const restored=await waitFrame(page,`${frameExpression}.decision?.kind === 'target'`);assert.deepEqual(restored.decision,target.decision);
  await page.getByRole('button',{name:'down',exact:true}).click();
  const thrown=await waitFrame(page,`${frameExpression}.decision === null && ${frameExpression}.outcome?.action === 'throw'`);
  assert.equal(thrown.observation.turn,initial.observation.turn+1);assert.ok(thrown.observation.here.items.some(i=>i.label.includes('dagger')));
  await page.getByRole('button',{name:'Engrave',exact:true}).click();await waitFrame(page,`${frameExpression}.decision?.kind === 'item'`);
  await page.getByRole('button',{name:'Hands / no item',exact:true}).click();
  const text=await waitFrame(page,`${frameExpression}.decision?.kind === 'text'`);
  await page.getByRole('button',{name:'Retire',exact:true}).click();await page.reload();await page.getByRole('button',{name:'Resume',exact:true}).click();
  assert.deepEqual((await waitFrame(page,`${frameExpression}.decision?.kind === 'text'`)).decision,text.decision);
  await page.getByLabel('Your answer',{exact:true}).fill('A visitor');await page.getByRole('button',{name:'Answer',exact:true}).click();
  const engraved=await waitFrame(page,`${frameExpression}.decision === null && ${frameExpression}.outcome?.action === 'engrave'`);
  assert.ok(engraved.outcome.turnsElapsed>0);assert.deepEqual(errors,[]);
});

test('browser controlled marker and spell chains expose each genuine item, text and target choice', {timeout:60_000}, async t=>{
  const {scenarioEngine}=await import('../pickup-engine-fixture.mjs');
  const {fileURLToPath}=await import('node:url');const {dirname}=await import('node:path');
  const options=await scenarioEngine(t,true,'manual-fixture.inc','manual_fixture');
  const directory=dirname(fileURLToPath(options.workerUrl));const {page,errors}=await fixture(t,directory);
  await page.waitForFunction(()=>document.querySelector('neonethack-example').api && !document.querySelector('neonethack-example').busy);
  await page.evaluate(async()=>{
    const {createWasm}=await import('/lib/neonethack/dist/typescript/wasm.js');const element=document.querySelector('neonethack-example');
    await element.api.close();const diagnostics=[];element.api=await createWasm({workerUrl:new URL('/__manual_fixture__/core-worker.mjs',location.href),onDiagnostic:message=>diagnostics.push(message)});
    try {element.game=await element.api.create({name:'BrowserManual',seed:42,role:'wizard',race:'human',gender:'female',align:'neutral'});} catch(error){throw Error(String(error)+'; engine: '+diagnostics.join(' | '));}element.show(element.game.state);element.renderControls();
  });
  await page.getByRole('button',{name:'Apply',exact:true}).click();
  let r=await waitFrame(page,`${frameExpression}.decision?.kind === 'item'`);const marker=r.decision.options.find(i=>i.label.includes('writing-marker'));
  await page.getByRole('button',{name:marker.label,exact:true}).click();r=await waitFrame(page,`${frameExpression}.decision?.kind === 'item' && ${frameExpression}.decision?.about.includes('write on')`);
  const paper=r.decision.options.find(i=>i.label.includes('blank-paper'));assert.ok(paper);
  await page.getByRole('button',{name:paper.label,exact:true}).click();await waitFrame(page,`${frameExpression}.decision?.kind === 'text'`);
  await page.getByRole('button',{name:'Cancel choice',exact:true}).click();await waitFrame(page,`${frameExpression}.decision === null`);
  await page.getByRole('button',{name:'Cast',exact:true}).click();r=await waitFrame(page,`${frameExpression}.decision?.kind === 'choice'`);
  const spell=r.decision.options.find(i=>i.label.includes('force bolt'));await page.getByLabel(spell.label,{exact:true}).check();await page.getByRole('button',{name:'Choose',exact:true}).click();
  await waitFrame(page,`${frameExpression}.decision?.kind === 'target'`);await page.getByRole('button',{name:'up',exact:true}).click();r=await waitFrame(page,`${frameExpression}.decision === null && ${frameExpression}.outcome?.action === 'cast'`);
  assert.ok(r.outcome.turnsElapsed>0);assert.deepEqual(errors,[]);
  await page.evaluate(()=>document.querySelector('neonethack-example').api.close());
});

test('WASM private RNG evidence survives IndexedDB reload and rejects damaged boundaries', {timeout:60000}, async t => {
  const {page}=await fixture(t);
  for(const damage of ['none','empty','torn','changed','extra']){
    const name='rng-'+damage;
    const saved=await page.evaluate(async name=>{
      const {createWasm}=await import('/lib/neonethack/dist/typescript/wasm.js');
      const api=await createWasm({storage:{kind:'indexeddb',name}});
      try{
        const game=await api.create({name:'Witness',seed:42,role:'wizard'});
        const request={version:1,method:'game.search',params:{sessionId:game.id,requestId:'rng-search',expectedRevision:game.state.revision,turns:5}};
        const receipt=await api.transport.send(request);
        return {id:game.id,request,receipt};
      }finally{await api.close();}
    },name);
    const path=`/neonethack/${name}/${saved.id}/rng.jsonl`;
    const original=await storedFile(page,name,path);
    assert.ok(original.length>0);
    let damaged=original;
    if(damage==='empty')damaged='';
    if(damage==='torn')damaged=original.slice(0,-1);
    if(damage==='changed')damaged=original.replace(/"draws":"\d+"/,'"draws":"999999999"');
    if(damage==='extra')damaged=original+original.split('\n')[0]+'\n';
    if(damage!=='none')await storedFile(page,name,path,damaged);
    await page.reload();
    const result=await page.evaluate(async ({name,saved})=>{
      const {createWasm}=await import('/lib/neonethack/dist/typescript/wasm.js');
      const api=await createWasm({storage:{kind:'indexeddb',name}});
      try{
        const resumed=await api.request('session.resume',{sessionId:saved.id});
        if(resumed.error)return {error:resumed.error};
        const receipt=await api.transport.send(saved.request);
        await api.request('session.lookup',{sessionId:saved.id,name:'floating eye'});
        await api.request('session.observe',{sessionId:saved.id});
        return {resumed,receipt};
      }finally{await api.close();}
    },{name,saved});
    if(damage==='none'){
      assert.deepEqual(result.resumed.observation,saved.receipt.observation);
      assert.deepEqual(result.receipt,saved.receipt);
      for(const line of original.trim().split('\n')){
        const record=JSON.parse(line);
        assert.ok(!JSON.stringify(result).includes(record.rng.core.state),'private fingerprint is absent from public receipts');
      }
    }else assert.equal(result.error?.code,'replayIntegrityError',JSON.stringify(result));
    assert.equal(await storedFile(page,name,path),damaged,'replay and free queries never rewrite RNG evidence');
  }
});

test('WASM receipt binding rejects changed historical text and restores exact receipts', {timeout:30000}, async t=>{
  const {page}=await fixture(t),name='receipt-binding';
  const saved=await page.evaluate(async name=>{
    const {createWasm}=await import('/lib/neonethack/dist/typescript/wasm.js');
    const api=await createWasm({storage:{kind:'indexeddb',name}});
    try{
      const game=await api.create({name:'Witness',seed:42,role:'wizard'});
      const request={version:1,method:'game.search',params:{sessionId:game.id,requestId:'bound-search',expectedRevision:game.state.revision}};
      return {id:game.id,request,receipt:await api.transport.send(request)};
    }finally{await api.close();}
  },name);
  const path=`/neonethack/${name}/${saved.id}/perceptions.jsonl`;
  const original=await storedFile(page,name,path);
  const altered=original.trimEnd().split('\n').map(line=>{
    const entry=JSON.parse(line);
    if(entry.response.requestId==='bound-search'){entry.response.observation.heard=['Changed historical text'];return JSON.stringify(entry);}
    return line;
  }).join('\n')+'\n';
  assert.notEqual(altered,original);
  for(const bytes of [altered,original]){
    await storedFile(page,name,path,bytes);await page.reload();
    const result=await page.evaluate(async({name,saved})=>{
      const {createWasm}=await import('/lib/neonethack/dist/typescript/wasm.js');
      const api=await createWasm({storage:{kind:'indexeddb',name}});
      try{
        const resumed=await api.request('session.resume',{sessionId:saved.id});
        return resumed.error?resumed:await api.transport.send(saved.request);
      }finally{await api.close();}
    },{name,saved});
    if(bytes===altered)assert.equal(result.error?.code,'recordingUnavailable');
    else assert.deepEqual(result,saved.receipt);
    const after=await storedFile(page,name,path);
    if(bytes===altered)assert.equal(after,bytes,'failed resume preserves suspect bytes');
    else assert.ok(after.startsWith(original),'successful resume preserves every original record');
  }
});

test('cloud outage does not block a new local game or its local resume', {timeout:30000}, async t=>{
  const {page,server}=await fixture(t);
  const original=server.listeners('request')[0];server.removeAllListeners('request');
  server.on('request',(req,res)=>{
    if(req.url.startsWith('/unavailable-cloud')){res.writeHead(503,{'content-type':'text/plain'});res.end('Unavailable');}
    else original(req,res);
  });
  const result=await page.evaluate(async()=>{
    const {createWasm}=await import('/lib/neonethack/dist/typescript/wasm.js');
    const storage={kind:'indexeddb',name:'outage-start',replicaUrl:new URL('/unavailable-cloud',location.href).href};
    let api=await createWasm({storage}),id,saved;
    try{const game=await api.create({name:'Local',seed:42,role:'wizard'});id=game.id;await game.search();saved=structuredClone(game.observation);}
    finally{await api.close();}
    api=await createWasm({storage});
    try{const game=await api.resume(id);return {saved,resumed:game.observation};}
    finally{await api.close();}
  });
  assert.deepEqual(result.resumed,result.saved);
});

test('human replacement of a question cannot retarget a registered WebMCP answer', {timeout:60_000}, async t=>{
  const {page,errors}=await fixture(t);
  await page.getByRole('button',{name:'New world',exact:true}).click();
  const created=await waitFrame(page,`${frameExpression}.observation?.turn === 1`);
  await page.getByRole('button',{name:'Pray',exact:true}).click();
  const old=await waitFrame(page,`${frameExpression}.decision?.kind === 'confirmation'`);
  await page.evaluate(async sid=>{
    const {registerWebMcp}=await import('/lib/neonethack/dist/typescript/webmcp.js');
    const example=document.querySelector('neonethack-example');
    globalThis.bindingTools=new Map();
    // Capture the public registration callbacks; the engine and human controls
    // are the real shared browser WASM game, not a simulated transport.
    globalThis.bindingRegistration=await registerWebMcp(example.api.transport,{registerTool(tool){globalThis.bindingTools.set(tool.name,tool);}});
    await globalThis.bindingTools.get("observe").execute({sessionId:sid});
  },created.sessionId);
  await page.getByRole('button',{name:'Cancel choice',exact:true}).click();
  await waitFrame(page,`${frameExpression}.decision === null`);
  await page.getByRole('button',{name:'Pray',exact:true}).click();
  const newer=await waitFrame(page,`${frameExpression}.decision?.kind === 'confirmation'`);
  assert.notEqual(newer.decision.id,old.decision.id);
  const result=await page.evaluate(async({sid,oldId})=>{
    const tools=globalThis.bindingTools;
    await tools.get("observe").execute({sessionId:sid});
    const stale=await tools.get("answer").execute({sessionId:sid,decisionId:oldId,value: true});
    const current=await tools.get("observe").execute({sessionId:sid});
    globalThis.bindingRegistration.dispose();
    return {stale:stale.structuredContent,current:current.structuredContent};
  },{sid:created.sessionId,oldId:old.decision.id});
  assert.equal(result.stale.error?.code,'staleDecision');
  assert.equal(result.stale.operationId,undefined);
  assert.deepEqual(result.current.decision,newer.decision);
  assert.equal(result.current.observation.turn,newer.observation.turn);
  assert.equal(result.current.ended,false);
  await page.getByRole('button',{name:'No',exact:true}).click();
  await waitFrame(page,`${frameExpression}.decision === null`);
  assert.deepEqual(errors,[]);
});

test('browser WebMCP leads with terminal facts after explicit quit and keeps disconnected close resumable', {timeout:60_000}, async t=>{
  const {page,errors}=await fixture(t);
  const result=await page.evaluate(async()=>{
    const {createWasm}=await import('/lib/neonethack/dist/typescript/wasm.js');
    const {registerWebMcp}=await import('/lib/neonethack/dist/typescript/webmcp.js');
    const api=await createWasm({storage:{kind:'memory'}}),tools=new Map();
    const registration=await registerWebMcp(api.transport,{registerTool(tool){tools.set(tool.name,tool);}});
    const call=async(name,args)=>(await tools.get(name).execute(args)).structuredContent;
    try{
      const created=await call("create",{seed:42,role:'valkyrie'}),sid={sessionId:created.sessionId};
      const closed=await call("suspend",sid),resumed=await call("resume",sid);
      const question=await call("quit",sid);
      const terminal=await call("answer",{...sid,decisionId:question.decision.id,value: true});
      const receipt=await call('receipt',{...sid,operationId:terminal.operationId});
      const observed=await call("observe",sid);
      const navigation=await call('go',{...sid,to:observed.observation.you});
      return {closed,resumed,terminal,receipt,observed,navigation};
    }finally{registration.dispose();await api.transport.close();}
  });
  assert.equal(result.closed.end.kind,'disconnected');assert.ok(!result.closed.summary.includes('Run ended'));
  assert.equal(result.resumed.ended,false);assert.equal(result.resumed.end,null);
  assert.equal(result.terminal.ended,true);assert.equal(result.terminal.end.kind,'quit');
  assert.equal(result.receipt.observation,undefined);
  for(const frame of [result.terminal,result.receipt.receipt,result.observed,result.navigation]){
    assert.ok(frame.summary.startsWith('Run ended (quit)'));
    if(frame.end.cause)assert.ok(frame.summary.split('.')[0].includes(frame.end.cause));
    assert.deepEqual(frame.end,result.terminal.end);
    assert.equal(frame.outcome.turnsElapsed,0);
  }
  assert.deepEqual(result.receipt.receipt.outcome,result.terminal.outcome);
  assert.equal(result.receipt.operationId,result.terminal.operationId);
  assert.ok(result.navigation.summary.endsWith('Navigation: ended; 0 actions, 0 turns elapsed.'));
  assert.equal(result.navigation.operationId,undefined);
  assert.deepEqual(errors,[]);
});
