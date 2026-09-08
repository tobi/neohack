import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createTestHarness} from './server.mjs';
import {chromium} from '../../../web/neohack.dev/node_modules/playwright-core/index.mjs';

async function fixture(t) {
  const server=createTestHarness(),{url}=await server.listen();
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM??'/usr/bin/chromium',headless:true,chromiumSandbox:true});
  const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
  t.after(async()=>{await browser.close();await server.close()});
  return {context,page,url};
}
async function create(page,url) {
  await page.goto(url.href);await page.waitForFunction(()=>!document.querySelector('#new-adventure').disabled);
  await page.getByRole('button',{name:'Begin your adventure',exact:true}).click();
  await page.getByLabel('YOUR NAME',{exact:true}).fill('Registration');
  await page.locator('input[name=role][value=valkyrie]').check();
  await page.getByText('Choose a world seed (optional)',{exact:true}).click();
  await page.getByLabel('A number for a repeatable starting world').fill('9');
  await page.getByRole('button',{name:'Enter the dungeon →',exact:true}).click();
  await ready(page);
}
const ready=page=>page.waitForFunction(()=>document.querySelector('pixel-nethack').snapshot?.observation&&document.querySelector('pixel-nethack').getAttribute('aria-busy')==='false');
const beginFlush=page=>page.evaluate(()=>{const app=document.querySelector('pixel-nethack');window.upload=app.inputTransport.flushRecording(app.game.id).catch(error=>{if(error.message==='Transport is closed')return {count:0};throw error})});
const waitTurn=page=>page.evaluate(async()=>{const app=document.querySelector('pixel-nethack'),before=app.snapshot.observation.turn;await app.run(()=>app.game.wait());return {before,after:app.snapshot.observation.turn}});
async function holdRegistration(context) {
  let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
  await context.route('**/api/vaults/*/adventures',async route=>{
    if(route.request().method()==='PUT'){entered();await gate;}
    await route.continue().catch(()=>{});
  });
  return {release,started};
}
async function pendingHash(page) {
  return page.evaluate(async()=>{
    const app=document.querySelector('pixel-nethack');
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('neonethack-inputs-v1:'+app.storeName,1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
    try{return await new Promise((resolve,reject)=>{const r=db.transaction('uploads').objectStore('uploads').get(app.game.id);r.onsuccess=()=>resolve(r.result?.pending?.hash);r.onerror=()=>reject(r.error)})}finally{db.close()}
  });
}

test('delayed registration permits real turns and sends no premature input PUT; lost ack retries identical bytes',{timeout:60000},async t=>{
  const {page,context,url}=await fixture(t),held=await holdRegistration(context);t.after(held.release);
  const attempts=[];let lost=false;
  await context.route('**/api/runs/*/inputs',async route=>{
    if(route.request().method()!=='PUT')return route.continue();
    const response=await route.fetch();attempts.push({status:response.status(),hash:route.request().headers()['x-content-sha256']});
    if(!lost){lost=true;return route.abort('failed')}
    await route.fulfill({response});
  });
  await create(page,url);await beginFlush(page);await held.started;
  const turns=await waitTurn(page);assert.equal(turns.after,turns.before+1);assert.equal(attempts.length,0);
  const hash=await pendingHash(page);assert.ok(hash);
  held.release();await page.evaluate(()=>window.upload);
  assert.equal(attempts.length,1);assert.equal(attempts[0].status,200);assert.equal(await pendingHash(page),hash);
  const ack=await page.evaluate(async()=>{const app=document.querySelector('pixel-nethack');return app.inputTransport.flushRecording(app.game.id)});
  assert.equal(attempts[1].hash,hash);assert.ok(attempts.every(a=>a.status===200));assert.equal(ack.count,2);
  assert.equal(await page.evaluate(()=>document.querySelector('pixel-nethack').snapshot.observation.turn),turns.after,'registration/upload retry executes no input');
});

test('offline registration retains pending bytes across local reload and reconnect',{timeout:60000},async t=>{
  const {page,context,url}=await fixture(t);await create(page,url);
  await context.setOffline(true);const turns=await waitTurn(page);assert.equal(turns.after,turns.before+1);
  await beginFlush(page);assert.equal((await page.evaluate(()=>window.upload)).count,0);
  const hash=await pendingHash(page);assert.ok(hash);
  await page.evaluate(()=>document.querySelector('pixel-nethack').inputTransport.close());
  const held=await holdRegistration(context);t.after(held.release);
  const attempts=[];context.on('request',r=>{if(r.url().endsWith('/inputs')&&r.method()==='PUT')attempts.push(r.headers()['x-content-sha256'])});
  await context.setOffline(false);await page.reload();await ready(page);
  assert.equal(await page.evaluate(()=>document.querySelector('pixel-nethack').snapshot.observation.turn),turns.after);
  await beginFlush(page);await held.started;
  assert.equal(attempts.length,0);assert.equal(await pendingHash(page),hash);
  const resumed=await waitTurn(page);assert.equal(resumed.after,resumed.before+1);
  held.release();const ack=await page.evaluate(()=>window.upload);assert.equal(ack.count,3);assert.equal(attempts[0],hash);
});

test('close aborts an active registration without waiting for network or sending inputs',{timeout:45000},async t=>{
  const {page,context,url}=await fixture(t),held=await holdRegistration(context);t.after(held.release);
  const inputs=[];context.on('request',r=>{if(r.url().endsWith('/inputs')&&r.method()==='PUT')inputs.push(r.url())});
  await create(page,url);await beginFlush(page);await held.started;
  const hash=await pendingHash(page);assert.ok(hash);
  const result=await page.evaluate(async()=>{const app=document.querySelector('pixel-nethack'),start=performance.now();await app.inputTransport.close();return {duration:performance.now()-start,registrations:app.inputTransport.registrations.size}});
  assert.ok(result.duration<2000,JSON.stringify(result));assert.equal(result.registrations,0);assert.equal(inputs.length,0);
  assert.equal(await pendingHash(page),hash);
  held.release();
});

test('workshop play also waits for registration only in its background uploader',{timeout:60000},async t=>{
  const {page,context,url}=await fixture(t),held=await holdRegistration(context);t.after(held.release);
  const inputs=[];page.on('response',r=>{if(r.url().endsWith('/inputs')&&r.request().method()==='PUT')inputs.push(r.status())});
  await page.goto(new URL('/bots?example=curious-imp',url).href);await page.waitForSelector('.cm-content');
  await page.locator('#role').selectOption('valkyrie');
  await page.locator('#seed-mode').selectOption('fixed');await page.locator('#seed').fill('9');
  await page.locator('.cm-content').click();await page.keyboard.press('Control+a');
  await page.keyboard.insertText('export default {name:"Registration workshop",initialize({hero,game}) { hero.addEventListener("turn", async()=>{ await new Promise(resolve=>setTimeout(resolve,6000)); await game.wait(); }); }}');
  await page.locator('#test').click();await held.started;
  const before=await page.evaluate(()=>document.querySelector('#bot-world').snapshot.observation.turn);
  await page.waitForFunction(before=>document.querySelector('#bot-world').snapshot.observation.turn>before,before);
  assert.equal(inputs.length,0);
  held.release();await page.waitForResponse(r=>r.url().endsWith('/inputs')&&r.status()===200);
  assert.ok(inputs.every(status=>status===200));
  await page.locator('#stop').click();
});

test('unsettled host registration is bounded and cancellation releases transport resources',{timeout:45000},async t=>{
  const {page,url}=await fixture(t);await page.goto(url.href);
  const result=await page.evaluate(async()=>{
    const {createWasm}=await import('/runtime/typescript/wasm.js');
    const {buildId}=await(await fetch('/runtime/wasm/current.json')).json();
    let attempts=0,aborts=0;
    const api=await createWasm({storage:{kind:'journal',name:'registration-timeout-'+crypto.randomUUID(),uploadUrl:new URL('/api/runs/',location.href).href,uploadToken:crypto.randomUUID()},
      workerUrl:new URL('/runtime/wasm/'+buildId+'/core-worker.mjs',location.href),
      registerUpload:(_id,signal)=>{attempts++;signal.addEventListener('abort',()=>aborts++,{once:true});return new Promise(()=>{})}});
    try {
      const game=await api.create({name:'Timeout',role:'valkyrie',race:'human',gender:'female',align:'lawful',seed:9});
      const ack=await api.transport.flushRecording(game.id);
      const before=game.observation.turn;await game.wait();
      const after=game.observation.turn;
      const retry=api.transport.flushRecording(game.id).catch(()=>undefined);
      while(attempts<2)await new Promise(r=>setTimeout(r,10));
      const started=performance.now(),closing=api.close();
      const duringClose=await api.transport.flushRecording(game.id).then(()=>false,error=>error.message==='Transport is closed');
      await closing;
      await retry;
      const afterClose=await api.transport.flushRecording(game.id).then(()=>false,error=>error.message==='Transport is closed');
      return {count:ack.count,before,after,attempts,aborts,duringClose,afterClose,closeMs:performance.now()-started,pending:api.transport.registrations.size};
    } finally {await api.close()}
  });
  assert.equal(result.count,0);assert.equal(result.after,result.before+1,JSON.stringify(result));
  assert.equal(result.attempts,2);assert.equal(result.aborts,2);assert.equal(result.pending,0);assert.ok(result.closeMs<2000);
  assert.equal(result.afterClose,true);
  assert.equal(result.duringClose,true);
});
