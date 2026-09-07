import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createTestHarness } from './server.mjs';
import { chromium } from '../../../web/neohack.dev/node_modules/playwright-core/index.mjs';

async function fixture(t) {
  const root = resolve(import.meta.dirname, '..');
  const server = createTestHarness();
  let browser;
  t.after(async()=>{try {await browser?.close();} finally {await server.close();}});
  const {url} = await server.listen();
  browser = await chromium.launch({executablePath:process.env.CHROMIUM ?? '/usr/bin/chromium',headless:true,chromiumSandbox:true});
  return {url:url.href.replace(/\/$/,''),browser};
}
async function create(page, url) {
  await page.goto(url);
  await page.waitForFunction(() => !document.querySelector('#new-adventure').disabled);
  await page.getByRole('button', { name: 'Begin your adventure', exact: true }).click();
  await page.getByLabel('YOUR NAME', { exact: true }).fill('Bookmark');
  await page.locator('input[name=role][value=valkyrie]').check();
  // A repeatable start where Search can legitimately refuse a spotted monster.
  // Storage tests use Wait below: their input must actually spend a turn.
  await page.getByText('Choose a world seed (optional)', { exact: true }).click();
  await page.getByLabel('A number for a repeatable starting world').fill('9');
  await page.getByRole('button', { name: 'Enter the dungeon →', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('pixel-nethack').snapshot?.observation && document.querySelector('pixel-nethack').getAttribute('aria-busy') === 'false');
}
const snapshot = page => page.evaluate(() => document.querySelector('pixel-nethack').snapshot);
const synced = async page => {try {await page.waitForFunction(() => document.querySelector('#cloud-status').textContent === 'Saved online');} catch(error) {throw Error((await page.locator('#cloud-status').textContent()) + ' / ' + (await page.locator('#error').textContent()),{cause:error});}};

test('Cloud journal commits are atomic, retry-idempotent and reject stale writers', { timeout: 30000 }, async t => {
  const { url } = await fixture(t);
  const endpoint = `${url}/api/vaults/${crypto.randomUUID()}`;
  const commit = { version: 1, base: null, commit: crypto.randomUUID(), files: [], blocks: [] };
  const put = body => fetch(endpoint, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await put(commit)).status, 200);
  assert.equal((await put(commit)).status, 200);
  assert.equal((await put({ ...commit, base: crypto.randomUUID() })).status, 409);
  const next = { ...commit, base: commit.commit, commit: crypto.randomUUID() };
  assert.equal((await put(next)).status, 200);
  assert.equal((await put({ ...commit, commit: crypto.randomUUID() })).status, 409);
  assert.equal((await (await fetch(endpoint)).json()).revision, next.commit);
  const missing = { ...next, base: next.commit, commit: crypto.randomUUID(), files: [['/neonethack/test/input', { blocks: ['a'.repeat(64)] }]] };
  assert.equal((await put(missing)).status, 400);
  assert.equal((await (await fetch(endpoint)).json()).revision, next.commit);
});

test('turns do not wait for cloud uploads; a bookmark resumes through C in a fresh browser', { timeout: 60000 }, async t => {
  const { url, browser } = await fixture(t);
  const original = await browser.newContext();
  const page = await original.newPage();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let first = true;
  await original.route('**/api/vaults/*', async route => {
    if (route.request().method() !== 'PUT' || !first) return route.continue();
    first = false;
    const response = await route.fetch();
    entered(); await gate;
    await route.fulfill({ response });
  });
  await create(page, url);
  await started;
  const turn = (await snapshot(page)).observation.turn;
  await page.evaluate(async () => { const app = document.querySelector('pixel-nethack'); await app.run(() => app.game.wait()); });
  assert.equal((await snapshot(page)).observation.turn, turn + 1, 'turn completed while the server acknowledgement is held: ' + await page.locator('#error').textContent());
  release();
  await page.evaluate(async () => { const app = document.querySelector('pixel-nethack'); await app.run(() => app.game.pray()); });
  await synced(page);
  const before = await snapshot(page), bookmark = page.url();
  assert.match(bookmark, /#run=[A-Za-z0-9_-]+&vault=/);
  assert.equal(before.decision.kind, 'confirmation');
  await page.close();
  const fresh = await browser.newContext();
  const restored = await fresh.newPage();
  await restored.goto(bookmark);
  await restored.waitForFunction(() => document.querySelector('pixel-nethack').snapshot?.observation);
  const after = await snapshot(restored);
  assert.equal(after.sessionId, before.sessionId);
  assert.deepEqual(after.observation, before.observation);
  assert.deepEqual(after.decision, before.decision);
  await restored.evaluate(async () => { const app = document.querySelector('pixel-nethack'); await app.run(() => app.game.answer(app.game.decision.id, { kind: 'confirmation', confirm: false })); });
  assert.equal((await snapshot(restored)).observation.turn, before.observation.turn);
  await synced(restored);
  const latest = await snapshot(restored);
  await fresh.close();
  const returning = await original.newPage();
  await returning.goto(bookmark);
  await returning.waitForFunction(() => document.querySelector('pixel-nethack').snapshot?.observation);
  assert.deepEqual((await snapshot(returning)).observation, latest.observation);
  assert.equal((await snapshot(returning)).decision, null, 'an unchanged older browser cache refreshes from the newer cloud journal');
  await original.close();
});

test('lost cloud acknowledgement recovers the durable commit without replaying an action', { timeout: 60000 }, async t => {
  const { url, browser } = await fixture(t);
  const context = await browser.newContext();
  const page = await context.newPage();
  await create(page, url); await synced(page);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const accepted = new Promise(resolve => { entered = resolve; });
  let first = true;
  await context.route('**/api/vaults/*', async route => {
    if (route.request().method() !== 'PUT' || !first) return route.continue();
    first = false;
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    entered(); await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  await page.evaluate(async () => { const app = document.querySelector('pixel-nethack'); await app.run(() => app.game.wait()); });
  const before = await snapshot(page), bookmark = page.url();
  await accepted; await page.close(); release();
  const reopened = await context.newPage(); await reopened.goto(bookmark);
  await reopened.waitForFunction(() => document.querySelector('pixel-nethack').snapshot?.observation);
  const after = await snapshot(reopened);
  assert.equal(after.sessionId, before.sessionId);
  assert.deepEqual(after.observation, before.observation);
  assert.deepEqual(after.decision, before.decision);
  await context.close();
});

test('cloud saving waits five idle seconds, resets on play, and flushes on close', { timeout: 60000 }, async t => {
  const { url, browser } = await fixture(t);
  const page = await browser.newPage();
  await create(page, url); await synced(page);
  const uploads = [];
  page.on('request', request => {
    if (request.method() === 'PUT' && /\/api\/vaults\/[^/]+$/.test(request.url())) uploads.push(Date.now());
  });
  const waitTurn = () => page.evaluate(async () => {
    const app = document.querySelector('pixel-nethack');
    await app.run(() => app.game.wait());
  });
  await waitTurn();
  await page.waitForTimeout(3900);
  assert.equal(uploads.length, 0);
  assert.equal(await page.locator('#cloud-status').textContent(), 'Saved here');
  await waitTurn();
  const lastAction = Date.now();
  await page.waitForTimeout(2200);
  assert.equal(uploads.length, 0, 'new input resets the original timer');
  assert.equal(await page.locator('#cloud-status').textContent(), 'Saved here');
  await synced(page);
  assert.equal(uploads.length, 1, 'one coalesced upload after inactivity');
  assert.ok(uploads[0] - lastAction >= 4800);
  await waitTurn();
  const start = Date.now();
  await page.evaluate(async () => {
    const app = document.querySelector('pixel-nethack');
    await app.run(() => app.returnToDoorway());
  });
  assert.ok(Date.now() - start < 4000, 'explicit close bypasses the idle wait');
  assert.equal(uploads.length, 2);
  await page.close();
});

test('ledger ranks all runs, preserves progress, keeps diagnostics private and renders safely on mobile', {timeout:30000}, async t => {
  const {url,browser}=await fixture(t);
  const post=(path,body)=>fetch(url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const winner={id:'g-winning-run',name:'<img src=x onerror=alert(1)>',role:'valkyrie',turn:5000,maxLevel:20,ended:true,endKind:'ascended',vault:'PRIVATE',pending:{secret:'PRIVATE'}};
  assert.equal((await post('/api/runs',{runs:[winner]})).status,200);
  for(let batch=0;batch<5;batch++) assert.equal((await post('/api/runs',{runs:Array.from({length:50},(_,n)=>({id:`g-${batch}-${n}`,name:'Ada',role:'wizard',turn:10,maxLevel:1,ended:false}))})).status,200);
  await post('/api/runs',{runs:[{...winner,turn:1,ended:false,maxLevel:1}]});
  let stats=await (await fetch(url+'/api/stats')).json();
  assert.equal(stats.totals.runs,251);assert.equal(stats.totals.ascended,1);assert.equal(stats.totals.living,250);
  assert.equal(stats.best[0].id,winner.id);assert.equal(stats.best[0].turn,5000);
  assert.ok(!JSON.stringify(stats).includes('PRIVATE'));
  assert.equal((await post('/api/errors',{code:'module_load',message:'PRIVATE',url:'PRIVATE'})).status,204);
  assert.equal((await post('/api/errors',{code:'raw private message'})).status,400);
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.goto(url+'/dashboard');
  assert.equal(new URL(page.url()).pathname, '/dashboard');
  await page.waitForFunction(()=>document.querySelector('#runs').children.length===100);
  assert.ok((await page.locator('#runs tr').first().textContent()).includes(winner.name));
  assert.equal(await page.locator('#runs img').count(),0);
  assert.equal(await page.locator('#errors, #dungeon-health, #error-summary').count(),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.selectOption('#status','ascended');assert.equal(await page.locator('#runs tr').count(),1);
  await page.goto(url);
  await page.waitForFunction(()=>!document.querySelector('#new-adventure').disabled);
  // Hold the background report to prove the ledger is checked after its commit.
  // waitForFunction treats an async predicate's Promise as truthy immediately.
  let releaseReport, reportEntered, reportCount=0;
  const reportGate = new Promise(resolve => { releaseReport = resolve; });
  const reportStarted = new Promise(resolve => { reportEntered = resolve; });
  t.after(() => releaseReport());
  await page.route('**/api/errors', async route => {
    reportCount++; reportEntered(); await reportGate; await route.continue();
  });
  const reported = page.waitForResponse(response => new URL(response.url()).pathname === '/api/errors' && response.request().method() === 'POST');
  await page.evaluate(()=>{
    const error=new Error("Unexpected keyword 'with'. PRIVATE #vault=secret");
    for(let i=0;i<3;i++) window.dispatchEvent(new ErrorEvent('error',{error,message:error.message}));
  });
  await reportStarted;
  stats=await (await fetch(url+'/api/stats')).json();
  assert.equal('errors' in stats,false,'diagnostics are not public');
  releaseReport();
  const response = await reported;
  assert.equal(response.status(),204);
  stats=await (await fetch(url+'/api/stats')).json();
  assert.equal('errors' in stats,false);
  assert.equal(reportCount,1,'one browser report per category despite repeat errors');
  assert.ok(!JSON.stringify(stats).includes('PRIVATE'));
  await page.goto(url+'/dashboard');
  await page.waitForFunction(()=>document.querySelector('#runs').children.length>0);
  await page.screenshot({path:'/tmp/neohack-ledger-mobile.png',fullPage:true});
});

test('transient cloud failures retry the exact commit in the background without blocking turns',{timeout:60000},async t=>{
 const {url,browser}=await fixture(t);const page=await browser.newPage();await create(page,url);await synced(page);
 const bodies=[];let failed=0;
 await page.route('**/api/vaults/*',async route=>{
  if(route.request().method()!=='PUT')return route.continue();
  bodies.push(route.request().postData());if(failed++<2)return route.fulfill({status:503,body:'temporary failure'});return route.continue();
 });
 await page.evaluate(async()=>{const a=document.querySelector('pixel-nethack');await a.run(()=>a.game.wait());});
 const before=await snapshot(page);
 await page.waitForFunction(()=>document.querySelector('#cloud-status').textContent.includes('retrying'));
 assert.equal(await page.locator('#error').isVisible(),false,'transient save errors do not become gameplay alerts');
 await page.evaluate(async()=>{const a=document.querySelector('pixel-nethack');await a.run(()=>a.game.wait());});
 assert.equal((await snapshot(page)).observation.turn,before.observation.turn+1);
 await synced(page);assert.ok(bodies.length>=3);assert.equal(bodies[0],bodies[1]);assert.equal(bodies[1],bodies[2]);
});
