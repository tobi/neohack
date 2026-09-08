import {createBlockRun} from './published-block-fixture.mjs';
import {test} from 'node:test';import assert from 'node:assert/strict';
import {createTestHarness} from './server.mjs';import {chromium} from '../../../web/neohack.dev/node_modules/playwright-core/index.mjs';
test('published frame outbox survives reload and exact uploads recover from a lost acknowledgement',{timeout:120000},async t=>{
 const server=createTestHarness();const {url}=await server.listen();const browser=await chromium.launch({executablePath:process.env.CHROMIUM??'/usr/bin/chromium',headless:true,chromiumSandbox:true});t.after(async()=>{await browser.close();await server.close();});const page=await browser.newPage();
 let blocked=true,lost=false,uploaded=[],attempts=0;
 await page.route('**/api/runs/*/replay',async route=>{
  if(route.request().method()!=='PUT')return route.continue();
  attempts++;
  if(blocked)return route.fulfill({status:503,body:'temporarily unavailable'});
  uploaded.push(route.request().postData());
  if(!lost){lost=true;await route.fetch();return route.abort('failed');}
  return route.continue();
 });
 await createBlockRun(page,String(url));await page.keyboard.press('Escape');
 const state=await page.evaluate(async()=>{const app=document.querySelector('pixel-nethack');await app.run(()=>app.game.wait());await app.publicRecorder.tail;return app.snapshot;});
 assert.equal(attempts,0,'recording a real turn performs no replay PUT before flush');
 await page.evaluate(()=>document.querySelector('pixel-nethack').publicRecorder.flush());
 assert.ok(attempts>0,'explicit flush starts publication');
 const queued=await page.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('neohack-public-recordings-v1');r.onsuccess=()=>{const db=r.result,q=db.transaction('frames').objectStore('frames').count();q.onsuccess=()=>{resolve(q.result);db.close();};};r.onerror=()=>reject(r.error);}));assert.ok(queued>=2);
 // Same-origin reload recovers the durable frames even though no replay PUT was acknowledged.
 await page.reload();await page.waitForFunction(()=>document.querySelector('pixel-nethack').snapshot?.sessionId && document.querySelector('pixel-nethack').publicRecorder);
 blocked=false;
 await page.evaluate(async()=>{const app=document.querySelector('pixel-nethack');await app.publicRecorder.flush();await app.publicRecorder.flush();});
 await page.waitForFunction(()=>document.querySelector('#public-recording').textContent.includes('uploaded'));
 const replay=await fetch(new URL('/api/runs/'+state.sessionId+'/replay',url),{redirect:'manual'});
 assert.equal(replay.status,302);
 const manifest=await (await fetch(new URL(replay.headers.get('location'),url))).json();
 const frames=[];for(const chunk of manifest.chunks)frames.push(...(await (await fetch(new URL(chunk,replay.headers.get('location')))).json()).frames);
 assert.ok(manifest.count>=2);assert.equal(frames[0].observation.turn,1);assert.equal(frames.at(-1).revision,state.revision);
 const vault=new URL(page.url()).hash.slice(1);
 const token=new URLSearchParams(vault).get('vault');
 const writer=await fetch(new URL('/api/runs/'+state.sessionId+'/replay?publication=1',url),{headers:{authorization:'Bearer '+token},redirect:'manual'});
 assert.equal(writer.status,200,'writer reconciliation is JSON, not a playback redirect');
 const checkpoint=await writer.json();assert.equal(checkpoint.count,manifest.count);assert.equal(checkpoint.revision,state.revision);
 assert.ok(uploaded.length>=2);assert.equal(uploaded[0],uploaded[1],'lost ack retries the exact index and frame');
});


test('published frame recording appends bounded rows without reading historical frame payloads',{timeout:60000},async t=>{
 const server=createTestHarness();const {url}=await server.listen();const browser=await chromium.launch({executablePath:process.env.CHROMIUM??'/usr/bin/chromium',headless:true,chromiumSandbox:true});t.after(async()=>{await browser.close();await server.close();});const page=await browser.newPage();
 await page.goto(new URL('/dashboard',url).href);
 await page.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('neohack-public-recordings-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('queues');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction('queues','readwrite');tx.objectStore('queues').put({frames:[{revision:7}],index:2,bytes:16},'retained-recording');tx.oncomplete=()=>{db.close();resolve();};};}));
 await createBlockRun(page,String(url));
 const result=await page.evaluate(async()=>{
   const app=document.querySelector('pixel-nethack'),recorder=app.publicRecorder;await recorder.tail;
   const reads=[],originalGet=IDBObjectStore.prototype.get,originalAll=IDBObjectStore.prototype.getAll;
   IDBObjectStore.prototype.get=function(...args){if(this.transaction.db.name==='neohack-public-recordings-v1')reads.push(this.name);return originalGet.apply(this,args);};
   IDBObjectStore.prototype.getAll=function(...args){if(this.transaction.db.name==='neohack-public-recordings-v1')reads.push(this.name+':all');return originalAll.apply(this,args);};
   try {for(let i=1;i<=120;i++)recorder.record({...app.snapshot,revision:app.snapshot.revision+i});await recorder.tail;return {reads,stopped:recorder.stopped};}
   finally {IDBObjectStore.prototype.get=originalGet;IDBObjectStore.prototype.getAll=originalAll;}
 });
 const retained=await page.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('neohack-public-recordings-v1');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,q=db.transaction('queues').objectStore('queues').get('retained-recording');q.onsuccess=()=>{resolve(q.result);db.close();};};}));assert.deepEqual(retained,{frames:[{revision:7}],index:2,bytes:16});
 assert.equal(result.stopped,false);assert.equal(result.reads.length,120);assert.ok(result.reads.every(name=>name==='heads'),'only small counters are read, regardless of queue size');
});
