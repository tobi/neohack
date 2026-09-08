import {createBlockRun} from './published-block-fixture.mjs';
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
  const original = await browser.newContext({serviceWorkers:'block'});
  const page = await original.newPage();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let first = true;
  await original.route('**/api/runs/*/inputs', async route => {
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
  const fresh = await browser.newContext({serviceWorkers:'block'});
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

  await fresh.close();
  const returning = await original.newPage();
  await returning.goto(bookmark);
  await returning.waitForFunction(() => document.querySelector('pixel-nethack').snapshot?.observation);
  assert.deepEqual((await snapshot(returning)).observation, before.observation);
  assert.deepEqual((await snapshot(returning)).decision, before.decision, 'local-first entry preserves this browser’s exact pending decision rather than replacing it with another browser’s branch');
  await original.close();
});

test('lost cloud acknowledgement recovers the durable commit without replaying an action', { timeout: 60000 }, async t => {
  const { url, browser } = await fixture(t);
  const context = await browser.newContext({serviceWorkers:'block'});
  const page = await context.newPage();
  await create(page, url); await synced(page);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const accepted = new Promise(resolve => { entered = resolve; });
  let first = true;
  await context.route('**/api/runs/*/inputs', async route => {
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

test('cloud saving waits five idle seconds, resets on play, and explicit sharing bypasses the debounce', { timeout: 60000 }, async t => {
  const { url, browser } = await fixture(t);
  const page = await browser.newPage({serviceWorkers:'block'});
  await create(page, url); await synced(page);
  const uploads = [];
  page.on('request', request => {
    if (request.method() === 'PUT' && /\/api\/runs\/[^/]+\/inputs$/.test(request.url())) uploads.push(Date.now());
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
    await app.publicRecorder.flush();
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
 const {url,browser}=await fixture(t);const page=await browser.newPage({serviceWorkers:'block'});await create(page,url);await synced(page);
 const bodies=[];let failed=0;
 await page.route('**/api/runs/*/inputs',async route=>{
  if(route.request().method()!=='PUT')return route.continue();
  bodies.push(route.request().postDataBuffer().toString('base64'));if(failed++<2)return route.fulfill({status:503,body:'temporary failure'});return route.continue();
 });
 await page.evaluate(async()=>{const a=document.querySelector('pixel-nethack');await a.run(()=>a.game.wait());});
 const before=await snapshot(page);
 await page.waitForFunction(()=>document.querySelector('#cloud-status').textContent.includes('retrying'));
 assert.equal(await page.locator('#error').isVisible(),false,'transient save errors do not become gameplay alerts');
 await page.evaluate(async()=>{const a=document.querySelector('pixel-nethack');await a.run(()=>a.game.wait());});
 assert.equal((await snapshot(page)).observation.turn,before.observation.turn+1);
 await synced(page);assert.ok(bodies.length>=3);assert.equal(bodies[0],bodies[1]);assert.equal(bodies[1],bodies[2]);
});

test('UI starts and resumes a local game when both cloud journal and discovery fail',{timeout:60000},async t=>{
  const {url,browser}=await fixture(t),page=await browser.newPage({serviceWorkers:'block'});
  await page.route('**/api/vaults/**',route=>route.fulfill({status:200,contentType:'text/plain',body:'Unavailable'}));
  await create(page,url);
  const started=await snapshot(page);assert.ok(started.sessionId);
  assert.equal(await page.locator('#error').textContent(),'');
  await page.reload();
  await page.waitForFunction(()=>document.querySelector('pixel-nethack').snapshot?.sessionId);
  assert.equal((await snapshot(page)).sessionId,started.sessionId);
  assert.deepEqual((await snapshot(page)).observation,started.observation);
  assert.equal(await page.locator('#error').textContent(),'');
});

test('large exact cloud commits upload below the request limit and recover a lost final receipt',{timeout:60000},async t=>{
  const {url}=await fixture(t);
  const {ReplicaUploader}=await import('../../../lib/neonethack/wasm/replica-uploader.mjs');
  const {randomBytes,createHash}=await import('node:crypto');const {gzipSync}=await import('node:zlib');
  const blocks=Array.from({length:72},()=>{const raw=randomBytes(48*1024);return [createHash('sha256').update(raw).digest('hex'),{version:1,size:raw.length,codec:'gzip',data:gzipSync(raw).toString('base64')}];});
  const files=[['/neonethack/large/input.log.jsonl',{blocks:blocks.map(([id])=>id),size:72*48*1024}]];
  let outbox=null,cursor=null,lost=false;const sizes=[],finalBodies=[];
  const endpoint=`${url}/api/vaults/${crypto.randomUUID()}`;
  const store={snapshot:async()=>({version:1,files,blocks}),replicaOutbox:async(...args)=>args.length?(outbox=args[0]):outbox,replicaCursor:async rev=>cursor=rev};
  const uploader=new ReplicaUploader({store,url:endpoint,idle:60000,backoff:60000,fetch:async(u,options)=>{
    sizes.push(Buffer.byteLength(options.body));assert.ok(sizes.at(-1)<1024*1024);
    if(options.method==='PUT')finalBodies.push(options.body);
    const response=await fetch(u,options);
    if(options.method==='PUT'&&!lost){assert.equal(response.status,200);lost=true;throw Error('Lost final receipt');}
    return response;
  }});t.after(()=>uploader.close());
  uploader.pending=true;await uploader.upload(true);clearTimeout(uploader.timer);
  assert.ok(outbox);assert.equal(cursor,null);const exact=JSON.stringify(outbox);assert.ok(Buffer.byteLength(exact)>4*1024*1024);
  await uploader.upload(true);clearTimeout(uploader.timer);
  assert.equal(finalBodies.length,2);assert.equal(finalBodies[0],finalBodies[1]);
  assert.equal(cursor,JSON.parse(exact).commit);assert.equal(outbox,null);
  const {fetchCloudReplica}=await import("../../../lib/neonethack/wasm/cloud-replica.mjs");
  const stored=await fetchCloudReplica(endpoint);assert.deepEqual(stored.files,files);
  assert.deepEqual(Object.fromEntries(stored.blocks),Object.fromEntries(blocks));
});

test('cloud rejection stays in save status and never opens the gameplay error overlay',{timeout:30000},async t=>{
  const {url,browser}=await fixture(t),page=await browser.newPage({serviceWorkers:'block'});
  await page.route('**/api/runs/*/inputs',route=>route.request().method()==='PUT'&&!route.request().url().endsWith('/adventures')?route.fulfill({status:403,body:'Refused'}):route.continue());
  await create(page,url);
  await page.waitForFunction(()=>document.querySelector('#cloud-status').textContent.includes('retrying'));
  assert.equal(await page.locator('#error').textContent(),'');
  assert.ok((await snapshot(page)).sessionId);
});

test('updated network worker resumes an older package without changing its engine pin',{timeout:30000},async t=>{
  const {readFile,writeFile,cp,rm}=await import('node:fs/promises');
  const {createHash}=await import('node:crypto');
  const directory=resolve(import.meta.dirname,'../public/runtime/wasm');
  const current=JSON.parse(await readFile(directory+'/current.json','utf8'));
  const manifest=JSON.parse(await readFile(directory+'/'+current.buildId+'/manifest.json','utf8'));
  const worker=await readFile(directory+'/'+current.buildId+'/core-worker.mjs','utf8')+'\n// Distinct pinned host fixture.\n';
  manifest.files['core-worker.mjs']=createHash('sha256').update(worker).digest('hex');
  manifest.buildId=createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex');
  const fixtureDirectory=directory+'/'+manifest.buildId;
  await cp(directory+'/'+current.buildId,fixtureDirectory,{recursive:true});
  t.after(()=>rm(fixtureDirectory,{recursive:true,force:true}));
  await writeFile(fixtureDirectory+'/core-worker.mjs',worker);await writeFile(fixtureDirectory+'/manifest.json',JSON.stringify(manifest));
  const {url,browser}=await fixture(t),page=await browser.newPage({serviceWorkers:'block'});await page.goto(url);
  const result=await page.evaluate(async oldId=>{
    const {createWasm}=await import('/runtime/typescript/wasm.js');
    const current=await (await fetch('/runtime/wasm/current.json')).json();
    const old=[oldId];
    const base=id=>new URL('/runtime/wasm/'+id+'/',location.href).href;
    const storage={kind:'indexeddb',name:'pinned-network-update'};
    let api=await createWasm({storage,workerUrl:new URL('core-worker.mjs',base(old[0]))});let id,observation;
    try{const game=await api.create({name:'Pinned',seed:42,role:'wizard'});id=game.id;observation=structuredClone(game.observation);}finally{await api.close();}
    api=await createWasm({storage,workerUrl:new URL('core-worker.mjs',base(current.buildId)),runtimeUrl:base(old[0])});
    try{const game=await api.resume(id);return {pin:api.transport.buildId,expected:old[0],observation,resumed:game.observation};}finally{await api.close();}
  },manifest.buildId);
  assert.equal(result.pin,result.expected);assert.deepEqual(result.resumed,result.observation);
});

test('old conflicted vault receives a separate acknowledged backup without losing either copy',{timeout:90000},async t=>{
 const {url,browser}=await fixture(t),page=await browser.newPage({serviceWorkers:'block'});await createBlockRun(page,url);await synced(page);
 const endpoint=url+'/api/vaults/'+new URLSearchParams(new URL(page.url()).hash.slice(1)).get('vault');
 const branch=await page.evaluate(()=>document.querySelector('pixel-nethack').saves[0].branch);
 const head=await(await fetch(endpoint+'?branch='+branch)).json();
 assert.equal((await fetch(endpoint,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({...head,base:null,commit:head.revision})})).status,200);
 await page.route('**/api/vaults/*',route=>route.request().method()==='PUT'?route.fulfill({status:503,body:'temporary outage'}):route.continue());
 await page.evaluate(async()=>{const a=document.querySelector('pixel-nethack');await a.run(()=>a.game.wait());});
 await page.waitForFunction(()=>document.querySelector('#cloud-status').textContent.includes('retrying'));
 const retained=await page.evaluate(()=>new Promise((resolve,reject)=>{
   const a=document.querySelector('pixel-nethack'),r=indexedDB.open('/neonethack/'+a.storeName);r.onerror=()=>reject(r.error);r.onsuccess=()=>{
     const db=r.result,tx=db.transaction('replica','readwrite'),store=tx.objectStore('replica'),q=store.get('outbox');store.delete('branch');
     tx.oncomplete=()=>{resolve(q.result);db.close();};
     for(const save of a.saves)delete save.branch;localStorage.setItem(a.indexKey,JSON.stringify(a.saves));
   };
 }));assert.ok(retained);
 const remote={version:1,base:head.revision,commit:crypto.randomUUID(),files:head.files,blocks:[]};
 assert.equal((await fetch(endpoint,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(remote)})).status,200);
 await page.unroute('**/api/vaults/*');await page.reload();
 await page.waitForFunction(()=>document.querySelector('pixel-nethack').snapshot?.sessionId);await synced(page);
 assert.equal((await(await fetch(endpoint)).json()).revision,remote.commit,'original cloud progress never overwritten');
 const archived=await page.evaluate(()=>new Promise(resolve=>{const a=document.querySelector('pixel-nethack'),r=indexedDB.open('/neonethack/'+a.storeName);r.onsuccess=()=>{const db=r.result,q=db.transaction('replica').objectStore('replica').get('previous-copy');q.onsuccess=()=>{resolve(q.result);db.close();};};}));
 assert.deepEqual(archived.outbox,retained,'previous uncertain upload retained exactly');
 const newBranch=await page.evaluate(()=>document.querySelector('pixel-nethack').saves[0].branch);assert.notEqual(newBranch,branch);
 assert.equal((await fetch(endpoint+'?branch='+newBranch)).status,200);
 assert.equal(await page.locator('#error').textContent(),'');
});

test('metadata retries independently, batches long histories and publishes new runs',{timeout:60000},async t=>{
 const {url,browser}=await fixture(t);const page=await browser.newPage({serviceWorkers:'block'});
 await page.route('**/api/health',r=>r.fulfill({status:503,body:'temporary outage'}));
 let deny=true;const batches=[];
 await page.route('**/api/runs',r=>{if(r.request().method()!=='POST')return r.continue();batches.push(JSON.parse(r.request().postData()).runs);return deny?r.fulfill({status:503,body:'retry later'}):r.continue();});
 await create(page,url);const id=(await snapshot(page)).sessionId;
 await page.evaluate(()=>{const a=document.querySelector('pixel-nethack');a.saves.push(...Array.from({length:105},(_,i)=>({id:'history-'+i,name:'History',role:'wizard',turn:i,ended:true,pending:{requestId:'PRIVATE-REQUEST'}})));a.persist();});
 await page.waitForTimeout(6000);deny=false;
 await page.evaluate(()=>window.dispatchEvent(new Event('online')));
 for(let i=0;i<40;i++){if((await(await fetch(url+'/api/runs?limit=1000')).json()).length===106)break;await page.waitForTimeout(500);}
 const runs=await (await fetch(url+'/api/runs?limit=1000')).json();assert.equal(runs.length,106);assert.ok(runs.some(r=>r.id===id));
 assert.ok(batches.every(b=>b.length<=50));assert.ok(!JSON.stringify(batches).includes('PRIVATE-REQUEST'));
 const vault=new URLSearchParams(new URL(page.url()).hash.slice(1)).get('vault');
 const privateRuns=await (await fetch(url+'/api/vaults/'+vault+'/adventures')).json();assert.equal(privateRuns.length,106);
 assert.ok(privateRuns.some(r=>r.pending?.requestId==='PRIVATE-REQUEST'),'private pending receipt context stays in private metadata');
 await synced(page);assert.equal(await page.locator('#error').textContent(),'');
});

test('two browsers can upload different runs in one vault without pausing sync',{timeout:90000},async t=>{
 const {url,browser}=await fixture(t);const first=await browser.newPage({serviceWorkers:'block'});await create(first,url);await synced(first);
 const a=await snapshot(first),bookmark=first.url();
 const testVault=new URLSearchParams(new URL(bookmark).hash.slice(1)).get('vault');
 const metas=await(await fetch(url+'/api/vaults/'+testVault+'/adventures')).json();assert.equal(metas[0].recording,'inputs');
 const second=await browser.newPage({serviceWorkers:'block'});await second.goto(bookmark);await second.waitForFunction(()=>document.querySelector('pixel-nethack').snapshot?.sessionId||document.querySelector('#error').textContent);assert.equal(await second.locator('#error').textContent(),'');await synced(second);
 await second.goto(url);await create(second,url);await synced(second);const b=await snapshot(second);assert.notEqual(a.sessionId,b.sessionId);
 await first.evaluate(async()=>{const a=document.querySelector('pixel-nethack');await a.run(()=>a.game.wait());});await synced(first);
 const endpoint=url+'/api/vaults/'+new URLSearchParams(new URL(bookmark).hash.slice(1)).get('vault');
 const config=await(await fetch(url+'/replay-config.json')).json();
 const getManifest=id=>fetch(new URL('replays/'+id+'/manifest.json',config.base)).then(r=>r.json());
 const head=await getManifest(a.sessionId),other=await getManifest(b.sessionId);
 assert.equal(head.id,a.sessionId);assert.equal(other.id,b.sessionId);assert.notEqual(head.chunks[0].path,other.chunks[0].path);
 const third=await browser.newPage({serviceWorkers:'block'});await third.goto(bookmark);await third.waitForFunction(()=>document.querySelector('pixel-nethack').snapshot?.sessionId||document.querySelector('#error').textContent);assert.equal(await third.locator('#error').textContent(),'');
 assert.equal((await snapshot(third)).observation.turn,(await snapshot(first)).observation.turn);await synced(third);
 const directory=await(await fetch(endpoint+'/adventures')).json();assert.equal(directory.find(s=>s.id===b.sessionId).recording,'inputs','each run retains its own input archive');
});

test('old local-recovery bookmarks automatically sync after an outage without a toggle',{timeout:60000},async t=>{
 const {url,browser}=await fixture(t),page=await browser.newPage({serviceWorkers:'block'});await create(page,url);await synced(page);const before=await snapshot(page);
 await page.route('**/api/runs/*/inputs',r=>r.request().method()==='PUT'?r.fulfill({status:503,body:'temporary outage'}):r.continue());
 const local=new URL(page.url()),hash=new URLSearchParams(local.hash.slice(1));hash.set('local','1');local.hash=hash.toString();await page.goto(local.href);await page.reload();
 await page.waitForFunction(()=>document.querySelector('pixel-nethack').snapshot?.sessionId);assert.equal((await snapshot(page)).sessionId,before.sessionId);
 await page.evaluate(async()=>{const a=document.querySelector('pixel-nethack');await a.run(()=>a.game.wait());});
 await page.waitForFunction(()=>document.querySelector('#cloud-status').textContent.includes('retrying'));
 assert.equal(await page.locator('#error').textContent(),'');assert.equal(await page.locator('#enable-cloud-backup').count(),0);
 await page.unroute('**/api/runs/*/inputs');await page.evaluate(()=>window.dispatchEvent(new Event('online')));await synced(page);
 assert.equal((await snapshot(page)).observation.turn,before.observation.turn+1);assert.ok(!page.url().includes('local=1'));
 const ledger=await(await fetch(url+'/api/runs/'+before.sessionId)).json();assert.equal(ledger.turn,before.observation.turn+1);
});


test('new and locally saved games enter without cloud reads',{timeout:60000},async t=>{
 const {url,browser}=await fixture(t),page=await browser.newPage({serviceWorkers:'block'});let reads=0;
 await page.addInitScript(()=>{AbortSignal.any=undefined;});
 await page.route('**/api/vaults/**',route=>{if(route.request().method()==='GET'){reads++;return route.fulfill({status:503,body:'offline'});}return route.continue();});
 await create(page,url);const before=await snapshot(page);assert.equal(reads,0,'new run never restores a cloud vault');
 await page.reload();await page.waitForFunction(()=>document.querySelector('pixel-nethack').snapshot?.observation);
 assert.equal((await snapshot(page)).sessionId,before.sessionId);assert.equal(reads,0,'local resume never downloads remote headers or blocks');
 await page.evaluate(async()=>{const app=document.querySelector('pixel-nethack');await app.run(()=>app.game.wait());});
 assert.equal((await snapshot(page)).observation.turn,before.observation.turn+1);
});

test('slow startup reports its stage without private data and resumes when download finishes',{timeout:45000},async t=>{
 const {url,browser}=await fixture(t),page=await browser.newPage({serviceWorkers:'block'});let release;
 const gate=new Promise(resolve=>release=resolve);t.after(()=>release());const diagnostics=[];
 await page.route('**/neonethack-core.wasm',async route=>{await gate;await route.continue();});
 page.on('request',r=>{if(new URL(r.url()).pathname==='/api/errors')diagnostics.push(r.postDataJSON());});
 await page.goto(url);await page.waitForFunction(()=>!document.querySelector('#new-adventure').disabled);
 await page.getByRole('button',{name:'Begin your adventure',exact:true}).click();await page.getByRole('button',{name:'Enter the dungeon →',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#loading-detail').textContent==='Downloading the game…');
 await new Promise(resolve=>setTimeout(resolve,10500));
 const slow=diagnostics.find(d=>d.code==='runtime_timing'&&d.timing.outcome==='slow');assert.ok(slow);assert.equal(slow.timing.stage,'assets');assert.deepEqual(Object.keys(slow).sort(),['buildId','code','timing']);
 release();await page.waitForFunction(()=>document.querySelector('pixel-nethack').snapshot?.observation);
 const bad=await fetch(url+'/api/errors',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:'runtime_timing',timing:{stage:'private-vault-token',duration:1,outcome:'slow'}})});assert.equal(bad.status,400);
});
