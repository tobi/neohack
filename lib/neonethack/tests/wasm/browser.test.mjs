import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { serveExample } from '../../scripts/serve-example.mjs';
async function fixture(t) {
  const server = await serveExample();
  t.after(() => new Promise(resolve => server.close(resolve)));
  const executablePath = process.env.CHROMIUM ?? (await access('/usr/bin/chromium').then(() => '/usr/bin/chromium', () => undefined));
  const browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(String(error)));
  const methods = []; page.on('request', req => methods.push(req.method()));
  const url = `http://127.0.0.1:${server.address().port}/examples/wasm/index.html`;
  await page.goto(url);
  t.after(async () => { if (errors.length) t.diagnostic(errors.join('\n')); });
  return { page, url, errors, methods };
}
const frame = async page => JSON.parse(await page.locator('#frame').textContent());
async function waitFrame(page, predicate) {
  await page.waitForFunction(predicate);
  return frame(page);
}
const frameExpression = `JSON.parse(document.querySelector('neonethack-example').shadowRoot.querySelector('#frame').textContent || '{}')`;

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
  const { page } = await fixture(t);
  const results = await page.evaluate(async () => {
    const { createWasm } = await import('/lib/neonethack/dist/typescript/wasm.js');
    const results = [];
    for (const damage of ['engine', 'input.log.jsonl']) {
      const name = damage === 'engine' ? 'wrong-build' : 'torn-input';
      const options = { storage: { kind: 'indexeddb', name } };
      let api = await createWasm(options);
      const game = await api.create({ name: 'Integrity', seed: 42, role: 'valkyrie', race: 'dwarf', gender: 'female', align: 'lawful' });
      await game.wait(); await api.close();
      const key = `/neonethack/${name}/${game.id}/${damage}`;
      async function file(transform) {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open(`/neonethack/${name}`);
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        try {
          return await new Promise((resolve, reject) => {
            const transaction = db.transaction('FILE_DATA', transform ? 'readwrite' : 'readonly');
            const store = transaction.objectStore('FILE_DATA'), request = store.get(key);
            let text;
            request.onsuccess = () => {
              const entry = request.result;
              if (!entry) { reject(Error('Missing test artifact')); return; }
              text = new TextDecoder().decode(entry.contents);
              if (transform) {
                text = transform(text); entry.contents = new TextEncoder().encode(text);
                entry.timestamp = new Date(entry.timestamp.getTime() + 1000); store.put(entry, key);
              }
            };
            transaction.oncomplete = () => resolve(text);
            transaction.onerror = () => reject(transaction.error);
          });
        } finally { db.close(); }
      }
      const damaged = await file(text => damage === 'engine' ? 'neonethack-wasm-build-v1:' + '0'.repeat(64) + '\n' : text + '{');
      api = await createWasm(options);
      const result = await api.request('session.resume', { sessionId: game.id });
      await api.close();
      results.push({ damage, error: result.error, unchanged: await file() === damaged });
    }
    return results;
  });
  assert.equal(results[0].error.code, 'engineError');
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
