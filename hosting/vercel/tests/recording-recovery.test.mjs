import {test} from 'node:test';import assert from 'node:assert/strict';
import {createTestHarness} from './server.mjs';import {chromium} from '../../../web/neohack.dev/node_modules/playwright-core/index.mjs';
test('replay outbox survives reload and exact uploads recover from a lost acknowledgement',{timeout:120000},async t=>{
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
 await page.goto(String(url));await page.waitForFunction(()=>!document.querySelector('#new-adventure').disabled);
 await page.getByRole('button',{name:'Begin your adventure',exact:true}).click();await page.getByLabel('YOUR NAME',{exact:true}).fill('Recording recovery');await page.getByRole('button',{name:'Enter the dungeon →',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('pixel-nethack').snapshot?.observation&&document.querySelector('pixel-nethack').getAttribute('aria-busy')==='false');await page.keyboard.press('Escape');
 const state=await page.evaluate(async()=>{const app=document.querySelector('pixel-nethack');await app.run(()=>app.game.wait());await app.publicRecorder.tail;return app.snapshot;});
 assert.equal(attempts,0,'recording a real turn performs no replay PUT before flush');
 await page.evaluate(()=>document.querySelector('pixel-nethack').publicRecorder.flush());
 assert.ok(attempts>0,'explicit flush starts publication');
 const queued=await page.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('neohack-public-recordings-v1');r.onsuccess=()=>{const db=r.result,q=db.transaction('queues').objectStore('queues').getAll();q.onsuccess=()=>{resolve(q.result.flatMap(q=>q.frames).length);db.close();};};r.onerror=()=>reject(r.error);}));assert.ok(queued>=2);
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
