import {test} from 'node:test';import assert from 'node:assert/strict';
import {fixture} from '../../../lib/neonethack/tests/native-fixture.mjs';
import {MemoryStorage,publicStoreFor,createTestHarness} from './server.mjs';
import {storageContext,AuthStore,immutable} from '../src/storage.ts';

test('only the owner publishes a private recording; private source and notes stay private; future frames follow the choice',async t=>{
 const{api}=await fixture(t);const game=await api.create({name:'Shared hero',role:'valkyrie',seed:7});
 const first=structuredClone(game.state);first.privateMarker='PRIVATE';first.storage={secret:'PRIVATE'};
 const store=new MemoryStorage(),id=crypto.randomUUID(),key='accounts/owner/runs/'+id+'.json';
 await storageContext.run(store,async()=>{
  const auth=new AuthStore();for(const userId of ['owner','other'])await auth.put('session:'+userId,{userId,expires:Date.now()+60000});
  await store.write(key,{frames:[await immutable(first)],notes:[await immutable({text:'PRIVATE'})],source:await immutable({artifact:'PRIVATE'}),run:{id,sessionId:first.sessionId,name:'Shared hero',role:'valkyrie',control:'interactive',automated:false,seed:7,buildId:'a'.repeat(64),count:1,revision:first.revision,turn:first.observation.turn,level:1,maxLevel:1,depth:'Dlvl:1',ended:false,partial:false}});
 });
 const server=createTestHarness({store});const{url}=await server.listen();t.after(()=>server.close());
 const post=(user='owner',body={public:true},origin=url.origin)=>fetch(new URL('/api/account/runs/'+id+'/publish',url),{method:'POST',headers:{origin,cookie:'nh_session='+user,'content-type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await post('anonymous')).status,401);assert.equal((await post('other')).status,404);assert.equal((await post('owner',{},'https://evil.test')).status,403);assert.equal((await post('owner',{})).status,400);
 const publicStore=publicStoreFor(store),write=publicStore.write.bind(publicStore);let fail=true;
 publicStore.write=async(...args)=>{if(fail)throw Error('storage temporarily down');return write(...args);};
 assert.equal((await post()).status,503);const reserved=(await store.read(key)).value.publicId;assert.ok(reserved);assert.equal((await store.read(key)).value.run.publishedCount,undefined);
 fail=false;const result=await post();assert.equal(result.status,200);const published=await result.json();assert.equal(published.publicId,reserved);assert.equal(published.publishedCount,1);
 assert.equal((await(await post()).json()).publicId,reserved,'retry keeps the same public identity');
 const manifest=(await publicStore.read('replays/'+reserved+'/manifest.json')).value;assert.equal(manifest.count,1);
 const publicFrame=(await publicStore.read('replays/'+reserved+'/'+manifest.chunks[0])).value.frames[0];assert.equal(publicFrame.sessionId,reserved);assert.ok(!JSON.stringify(publicFrame).includes('PRIVATE'));const expected=structuredClone(first.observation);delete expected.neighborhood;assert.deepEqual(publicFrame.observation,expected);
 assert.equal((await store.read(key)).value.source.length>0,true);assert.equal((await store.read(key)).value.notes.length,1);
 await game.wait();const next=structuredClone(game.state);
 fail=true;
 const appended=await fetch(new URL('/api/account/runs/'+id+'/frames',url),{method:'PUT',headers:{origin:url.origin,cookie:'nh_session=owner','content-type':'application/json'},body:JSON.stringify({index:1,frame:next,name:'Shared hero',role:'valkyrie',control:'interactive',seed:7,buildId:'a'.repeat(64)})});assert.equal(appended.status,200);
 assert.equal((await store.read(key)).value.run.count,2,'private append survives a failed public update');
 assert.equal((await publicStore.read('replays/'+reserved+'/manifest.json')).value.count,1);
 fail=false;assert.equal((await post()).status,200);
 assert.equal((await publicStore.read('replays/'+reserved+'/manifest.json')).value.count,2);
 assert.equal((await store.read(key)).value.run.publicId,reserved);
 const stats=await(await fetch(new URL('/api/stats',url))).json();assert.equal(stats.best.find(r=>r.id===reserved)?.replayAvailable,true);assert.ok(!JSON.stringify(stats).includes('PRIVATE'));
});
