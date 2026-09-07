import {test} from 'node:test';import assert from 'node:assert/strict';
import {createTestHarness} from './server.mjs';import {chromium} from '../../../web/neohack.dev/node_modules/playwright-core/index.mjs';
test('replay outbox survives reload and exact uploads recover from a lost acknowledgement',{timeout:120000},async t=>{
 const server=createTestHarness();const {url}=await server.listen();const browser=await chromium.launch({executablePath:process.env.CHROMIUM??'/usr/bin/chromium',headless:true,chromiumSandbox:true});t.after(async()=>{await browser.close();await server.close();});const page=await browser.newPage();
 let blocked=true,lost=false,uploaded=[];
 await page.route('**/api/runs/*/replay',async route=>{
  if(route.request().method()!=='PUT')return route.continue();
  if(blocked)return route.fulfill({status:503,body:'temporarily unavailable'});
  uploaded.push(route.request().postData());
  if(!lost){lost=true;await route.fetch();return route.abort('failed');}
  return route.continue();
 });
 await page.goto(String(url));await page.waitForFunction(()=>!document.querySelector('#new-adventure').disabled);
 await page.getByRole('button',{name:'Begin your adventure',exact:true}).click();await page.getByLabel('YOUR NAME',{exact:true}).fill('Recording recovery');await page.getByRole('button',{name:'Enter the dungeon →',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('pixel-nethack').snapshot?.observation&&document.querySelector('pixel-nethack').getAttribute('aria-busy')==='false');await page.keyboard.press('Escape');
 const state=await page.evaluate(async()=>{const app=document.querySelector('pixel-nethack');await app.run(()=>app.game.wait());await app.publicRecorder.flush();return app.snapshot;});
 const queued=await page.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('neohack-public-recordings-v1');r.onsuccess=()=>{const db=r.result,q=db.transaction('queues').objectStore('queues').getAll();q.onsuccess=()=>{resolve(q.result.flatMap(q=>q.frames).length);db.close();};};r.onerror=()=>reject(r.error);}));assert.ok(queued>=2);
 // Same-origin reload recovers the durable frames even though no replay PUT was acknowledged.
 await page.reload();await page.waitForFunction(()=>document.querySelector('pixel-nethack').snapshot?.sessionId && document.querySelector('pixel-nethack').publicRecorder);
 blocked=false;
 await page.evaluate(async()=>{const app=document.querySelector('pixel-nethack');await app.publicRecorder.flush();await app.publicRecorder.flush();});
 await page.waitForFunction(()=>document.querySelector('#public-recording').textContent.includes('uploaded'));
 const recording=await(await fetch(new URL('/api/runs/'+state.sessionId+'/replay',url))).json();
 assert.ok(recording.count>=2);assert.equal(recording.frames[0].observation.turn,1);assert.equal(recording.frames.at(-1).revision,state.revision);
 assert.ok(uploaded.length>=2);assert.equal(uploaded[0],uploaded[1],'lost ack retries the exact index and frame');
});
