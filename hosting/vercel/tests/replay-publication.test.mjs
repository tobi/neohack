import {test} from 'node:test';import assert from 'node:assert/strict';
import {MemoryStorage} from './server.mjs';import {storageContext,immutable} from '../src/storage.ts';
import {publicReplayContext} from '../src/public-replay-store.ts';import {publishReplay} from '../src/publish-replay.ts';

test('publication retries missing chunks and cannot roll back a newer static manifest',async()=>{
 const privateStore=new MemoryStorage(),publicStore=new MemoryStorage();
 await storageContext.run(privateStore,()=>publicReplayContext.run(publicStore,async()=>{
  const refs=await Promise.all(Array.from({length:5},(_,i)=>immutable({revision:i,observation:{turn:i+1}})));
  const key='replays/test.json',manifest='replays/test/manifest.json';
  const setCount=async count=>{const old=await privateStore.read(key);await privateStore.write(key,{frames:refs.slice(0,count),role:'wizard',seed:7},old?.etag);};
  await setCount(3);await publishReplay('test');
  const original=await publicStore.read(manifest);assert.equal(original.value.count,3);
  const write=publicStore.write.bind(publicStore);let fail=true;
  publicStore.write=async(path,value,etag)=>{if(fail&&path.includes('/chunks/'))throw Error('Publication interrupted');return write(path,value,etag);};
  await setCount(4);await assert.rejects(publishReplay('test'),/interrupted/);
  assert.deepEqual(await publicStore.read(manifest),original,'no manifest points at missing chunks');
  fail=false;let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
  publicStore.write=async(path,value,etag)=>{if(path===manifest&&value.count===4){entered();await gate;}return write(path,value,etag);};
  const older=publishReplay('test');await started;
  await setCount(5);await publishReplay('test');release();await older;
  const current=await publicStore.read(manifest);assert.equal(current.value.count,5);
  for(const chunk of current.value.chunks)assert.ok(await publicStore.read('replays/test/'+chunk));
  assert.ok(!JSON.stringify(current).includes('objects/'),'manifest exposes no private object paths');
 }));
});
