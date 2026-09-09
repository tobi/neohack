import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from '../../../lib/neonethack/tests/native-fixture.mjs';
import {createTestHarness,MemoryStorage,publicStoreFor} from './server.mjs';
import {storageContext,immutable} from '../src/storage.ts';
import {publicReplayContext} from '../src/public-replay-store.ts';
import {publishReplay} from '../src/publish-replay.ts';
import {saveLedgerRun} from '../src/ledger-store.ts';
import {chromium} from '../../../web/neohack.dev/node_modules/playwright-core/index.mjs';

test('dedicated replay page shares public identity, metadata and embeds without sign-in; 20x preserves every frame', {timeout:30000},async t=>{
 const {api}=await fixture(t),game=await api.create({name:'Replay Page',role:'valkyrie',seed:7});
 const frames=[structuredClone(game.state)];for(let i=0;i<5;i++){await game.wait();frames.push(structuredClone(game.state));}
 const id=game.state.sessionId,store=new MemoryStorage(),publicStore=publicStoreFor(store);
 await storageContext.run(store,async()=>{
  const refs=await Promise.all(frames.map(f=>immutable(f)));
  await store.write('replays/'+id+'.json',{frames:refs,role:'valkyrie',seed:7});
  await publicReplayContext.run(publicStore,()=>publishReplay(id));
  await saveLedgerRun({id,name:'Replay Page',role:'valkyrie',turn:game.state.observation.turn,ended:false,heroLevel:2,maxLevel:3,maxDepth:4,depthLabel:'Dungeon, level 4',updatedAt:Date.UTC(2026,8,9)});
 });
 const server=createTestHarness({store}),{url:base}=await server.listen(),url=base.origin;t.after(()=>server.close());
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM??'/usr/bin/chromium',headless:true,chromiumSandbox:true});t.after(()=>browser.close());
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));
 let releaseMetadata;
 const metadataGate=new Promise(resolve=>{releaseMetadata=resolve;});
 t.after(()=>releaseMetadata());
 await page.route('**/api/runs/'+id,async route=>{await metadataGate;await route.continue();});
 await page.goto(url+'/replays/'+id);
 await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Replay ready'));
 const selected=()=>page.locator('#run-details').evaluate(el=>Object.fromEntries([...el.children].map(item=>[item.querySelector('dt').textContent,item.querySelector('dd').textContent])));
 const initialDetails=await selected();
 assert.deepEqual(initialDetails,{Class:'valkyrie','Hero level':String(frames[0].observation.vitals.level),'Dungeon location':frames[0].observation.location.depthLabel,Turn:String(frames[0].observation.turn),State:'Adventuring'});
 assert.deepEqual(await page.evaluate(()=>document.querySelector('#replay').snapshot),frames[0],'page opens at the first recorded frame before metadata arrives');
 releaseMetadata();
 await page.waitForFunction(()=>document.querySelector('#replay-title').textContent==='Replay Page');
 assert.equal(await page.locator('#replay-title').textContent(),'Replay Page');
 assert.equal(await page.locator('#replay-id').textContent(),id);
 assert.deepEqual(await selected(),initialDetails,'late final metadata cannot overwrite the opening scene');
 assert.equal(await page.locator('#recorded-run').evaluate(el=>el.open),false,'run totals are initially collapsed');
 await page.getByText('Run totals and outcome',{exact:true}).click();
 assert.match(await page.locator('#run-totals').textContent(),/Dungeon, level 4/);
 assert.match(await page.locator('#run-totals').textContent(),/2026/);
 await page.getByText('Run totals and outcome',{exact:true}).click();
 const canonical=url+'/replays/'+id;
 assert.equal(await page.locator('#share-url').inputValue(),canonical);
 assert.match(await page.locator('#embed-code').inputValue(),new RegExp('/replays/'+id));
 const world=page.locator('#replay');
 assert.equal(await world.locator('#replay-page').getAttribute('href'),canonical);
 const openSite=world.getByRole('link',{name:'Open neohack.dev',exact:true});
 assert.equal(await openSite.getAttribute('target'),'_blank');
 assert.equal(await openSite.getAttribute('rel'),'noopener');
 assert.equal(await world.locator('.hud a').count(),0);
 assert.equal(await world.locator('#sound').count(),0);
 await world.getByLabel('Playback speed',{exact:true}).selectOption('20');
 await page.evaluate(()=>{window.positions=[];document.querySelector('#replay').addEventListener('replayframe',e=>window.positions.push(e.detail.index));});
 await world.getByRole('button',{name:'Play replay',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#replay').index===5);
 assert.deepEqual(await page.evaluate(()=>window.positions),[1,2,3,4,5]);
 assert.equal((await selected()).Turn,String(frames[5].observation.turn),'details follow playback');
 await world.getByLabel('Replay frame',{exact:true}).fill('0');
 assert.equal(await page.evaluate(()=>document.querySelector('#replay').index),0,'seeking retains the selected index when pausing');
 assert.deepEqual(await selected(),initialDetails,'seeking back restores opening details, not ledger totals');
 for(const viewport of [{width:1440,height:1000},{width:390,height:844},{width:320,height:667}]){
  await page.setViewportSize(viewport);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.deepEqual(await openSite.evaluate(el=>{
   const box=el.getBoundingClientRect(),bar=el.parentElement.getBoundingClientRect();
   return {text:el.innerText,readable:box.width>=44&&box.height>=44,inside:box.left>=bar.left&&box.right<=bar.right&&box.bottom<=bar.bottom,
    right:Math.abs(bar.right-box.right-10)<1,bottom:Math.abs(bar.bottom-box.bottom-10)<1};
  }),{text:'Open\nneohack.dev',readable:true,inside:true,right:true,bottom:true});
  await page.screenshot({path:`/tmp/neohack-replay-page-${viewport.width}.png`,fullPage:true});
 }
 // A denied clipboard still exposes selectable text; metadata is optional.
 await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:async()=>{throw Error('denied')}}}));
 await page.locator('#copy-link').click();assert.match(await page.locator('#copy-status').textContent(),/selected text/);
 await page.route('**/api/runs/*',r=>r.fulfill({status:503,json:{error:'unavailable'}}));
 await page.reload();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Replay ready'));
 assert.match(await page.locator('#metadata-status').textContent(),/unavailable/);
 assert.deepEqual(await selected(),initialDetails,'metadata failure does not affect the selected moment');
 await page.goto(url+'/replays/missing-recording');await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Replay unavailable'));
 assert.deepEqual(errors,[]);
});
