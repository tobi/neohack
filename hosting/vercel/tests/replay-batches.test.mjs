import {test} from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from '../../../lib/neonethack/node_modules/typescript/lib/typescript.js';
import {chromium} from '../../../web/neohack.dev/node_modules/playwright-core/index.mjs';
import {MemoryStorage,createTestHarness} from './server.mjs';
import {storageContext,immutable} from '../src/storage.ts';
import {publicReplayContext} from '../src/public-replay-store.ts';
import {replay} from '../src/replays.ts';
import {replayFrames} from '../src/replay-frames.ts';
import {publishReplay} from '../src/publish-replay.ts';

test('published frame batches append, merge small tails and reject changed retries or gaps',async()=>{
 const store=new MemoryStorage(),cdn=new MemoryStorage(),vault=crypto.randomUUID(),id='batch-fixture';
 await storageContext.run(store,()=>publicReplayContext.run(cdn,async()=>{
  await store.write('vaults/'+vault+'/adventures.json',{values:[{id,buildId:'a'.repeat(64),role:'wizard',seed:7}]});
  const frame=revision=>({version:1,sessionId:id,revision,ended:false,outcome:{action:'wait'},events:[],observation:{turn:revision+1,inventory:[],world:[],heard:[],vitals:{},location:{depthLabel:'Dlvl:1'},neighborhood:[{redundant:true}]}});
  const put=body=>replay(new Request('https://neohack.dev/api/runs/'+id+'/replay',{method:'PUT',headers:{authorization:'Bearer '+vault},body:JSON.stringify(body)}),id);
  const first={index:0,frames:[frame(0),frame(1),frame(2)]};
  assert.deepEqual(await(await put(first)).json(),{count:3,acknowledged:3});
  let doc=(await store.read('replays/'+id+'.json')).value;
  assert.equal(doc.batches.length,1);assert.equal(doc.batches[0].count,3);
  const oldBatch=doc.batches[0].ref;
  assert.equal(await store.read(doc.frames[0]),null,'one object stores the batch, not one object per frame');
  assert.equal((await put({index:3,frames:[frame(4),frame(5)]})).status,200);
  doc=(await store.read('replays/'+id+'.json')).value;
  assert.equal(doc.batches.length,1);assert.equal(doc.batches[0].count,5);
  assert.ok(await store.read(oldBatch),'previous immutable batch remains available');
  assert.deepEqual(await(await put(first)).json(),{count:5,acknowledged:3},'lost acknowledgement remains exact after a later append');
  assert.equal((await put({index:0,frames:[frame(99)]})).status,409);
  assert.equal((await put({index:6,frames:[frame(6)]})).status,409);
  assert.equal((await put({index:5,frames:[frame(7),frame(6)]})).status,400);
  assert.equal((await put({index:5,frame:frame(6)})).status,200,'already-published single-frame writers remain readable');
  doc=(await store.read('replays/'+id+'.json')).value;
  const frames=await replayFrames(doc,0,doc.frames.length);
  assert.deepEqual(frames.map(f=>f.revision),[0,1,2,4,5,6]);
  assert.ok(frames.every(f=>!('neighborhood' in f.observation)));
  const manifest=(await cdn.read('replays/'+id+'/manifest.json')).value,shown=[];
  for(const path of manifest.chunks)shown.push(...(await cdn.read('replays/'+id+'/'+path)).value.frames);
  assert.deepEqual(shown,frames,'static playback exactly matches committed frames');
  const corrupted=structuredClone(doc);corrupted.frames[1]=corrupted.frames[0];
  await assert.rejects(replayFrames(corrupted,0,2),/differs/);
 }));
});

test('publication uses current management revision when the CDN serves an old manifest',async()=>{
 const store=new MemoryStorage(),cdn=new MemoryStorage();
 await storageContext.run(store,()=>publicReplayContext.run(cdn,async()=>{
  const refs=await Promise.all(Array.from({length:5},(_,revision)=>immutable({revision})));
  const key='replays/stale.json',path='replays/stale/manifest.json';
  const set=async count=>{const current=await store.read(key);await store.write(key,{frames:refs.slice(0,count)},current?.etag);};
  await set(3);await publishReplay('stale');const cached=await cdn.read(path);
  await set(4);await publishReplay('stale');
  const read=cdn.read.bind(cdn);cdn.head=async name=>{const doc=await read(name);return doc?{etag:doc.etag}:null;};
  cdn.read=async name=>name===path?structuredClone(cached):read(name);
  await set(5);await publishReplay('stale');
  assert.equal((await read(path)).value.count,5);
 }));
});

test('lost acknowledgements of already-published full frames retain their exact original bytes',async()=>{
 const store=new MemoryStorage(),cdn=new MemoryStorage(),vault=crypto.randomUUID(),id='published-full';
 await storageContext.run(store,()=>publicReplayContext.run(cdn,async()=>{
  const buildId='b'.repeat(64),frame={version:1,sessionId:id,requestId:'published',revision:1,ended:false,observation:{turn:2,inventory:[],world:[],heard:[],vitals:{},location:{depthLabel:'Dlvl:1'},neighborhood:{cells:[]}},outcome:{action:'wait'},events:[],decision:null};
  const ref=await immutable(frame),owner=createHash('sha256').update(vault).digest('hex');
  await store.write('vaults/'+vault+'/adventures.json',{values:[{id,buildId}]});
  await store.write('replays/'+id+'.json',{owner,frames:[ref],revision:1,buildId});
  const request=new Request('https://neohack.dev/api/runs/'+id+'/replay',{method:'PUT',headers:{authorization:'Bearer '+vault},body:JSON.stringify({index:0,frame})});
  const response=await replay(request,id);
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{count:1,acknowledged:1});
  assert.deepEqual((await store.read(ref)).value,frame);
  assert.deepEqual((await store.read('replays/'+id+'.json')).value.frames,[ref]);
 }));
});

test('published outbox upgrades one run, retains exact pending batches and appends without scanning history',{timeout:60000},async t=>{
 const server=createTestHarness(),{url}=await server.listen();
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM??'/usr/bin/chromium',headless:true,chromiumSandbox:true});
 t.after(async()=>{await browser.close();await server.close();});const page=await browser.newPage();
 const source=await readFile(new URL('../../../web/neohack.dev/src/replay-outbox.ts',import.meta.url),'utf8');
 const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 await page.route('**/outbox-probe.js',route=>route.fulfill({contentType:'text/javascript',body:js}));
 await page.goto(new URL('/dashboard',url).href);
 await page.evaluate(()=>new Promise((resolve,reject)=>{
  const r=indexedDB.open('neohack-public-recordings-v1',2);
  r.onupgradeneeded=()=>{for(const name of ['queues','heads','frames'])r.result.createObjectStore(name);};
  r.onerror=()=>reject(r.error);r.onsuccess=()=>{
   const db=r.result,tx=db.transaction(['heads','frames','queues'],'readwrite');
   tx.objectStore('heads').put({index:0,count:130,bytes:1},'existing');
   for(let revision=0;revision<130;revision++)tx.objectStore('frames').put({revision},['existing',revision]);
   tx.objectStore('queues').put({frames:[{revision:9}],index:7,bytes:16},'untouched');
   tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);
  };
 }));
 const first=await page.evaluate(async()=>{
  const o=await import('/outbox-probe.js');await o.replayQueue('existing');
  return o.nextReplayBatch('existing');
 });
 assert.equal(first.frames.length,128);assert.equal(first.index,0);
 const reads=await page.evaluate(async()=>{
  const o=await import('/outbox-probe.js'),reads=[];
  const get=IDBObjectStore.prototype.get,cursor=IDBObjectStore.prototype.openCursor;
  IDBObjectStore.prototype.get=function(...args){reads.push(this.name);return get.apply(this,args);};
  IDBObjectStore.prototype.openCursor=function(...args){reads.push(this.name+':cursor');return cursor.apply(this,args);};
  try{await o.appendReplay('existing',{revision:130});}finally{IDBObjectStore.prototype.get=get;IDBObjectStore.prototype.openCursor=cursor;}
  return reads;
 });
 assert.deepEqual(reads,['heads'],'walking does not read a pending batch or any historical frame');
 await page.reload();
 const after=await page.evaluate(async first=>{
  const o=await import('/outbox-probe.js'),retry=await o.nextReplayBatch('existing');
  let rejected=false;try{await o.acknowledgeReplay('existing',retry,129);}catch{rejected=true;}
  const before=await o.replayQueue('existing');
  await o.acknowledgeReplay('existing',first,128);
  return {retry,rejected,before,after:await o.replayQueue('existing'),next:await o.nextReplayBatch('existing')};
 },first);
 assert.deepEqual(after.retry,first);assert.equal(after.rejected,true);assert.equal(after.before.count,131);
 assert.equal(after.after.count,3);assert.deepEqual(after.next,{index:128,frames:[{revision:128},{revision:129},{revision:130}]});
 const retained=await page.evaluate(()=>new Promise(resolve=>{const r=indexedDB.open('neohack-public-recordings-v1');r.onsuccess=()=>{const db=r.result,q=db.transaction('queues').objectStore('queues').get('untouched');q.onsuccess=()=>{resolve(q.result);db.close();};};}));
 assert.deepEqual(retained,{frames:[{revision:9}],index:7,bytes:16});
});
