import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MemoryStorage,createTestHarness,publicStoreFor} from './server.mjs';
import {storageContext} from '../src/storage.ts';
import {publicReplayContext} from '../src/public-replay-store.ts';
import {ledgerStats,ledgerRun,saveLedgerRun,markRecorded,vaultOwner} from '../src/ledger-store.ts';
import {sanitizeRun} from '../src/board.ts';
const now=Date.UTC(2026,8,11,12);
const VAULT='11111111-1111-4111-8111-111111111111', OTHER='22222222-2222-4222-8222-222222222222';
const run=(id,overrides={})=>({id,name:'Hero',role:'wizard',turn:100,maxLevel:2,maxDepth:1,ended:false,...overrides});

test('impossible engine values reject the upload; unknown values stay omitted',()=>{
 const clean=sanitizeRun(run('ok',{heroLevel:30,maxLevel:30,maxDepth:512,turn:10_000_000,endKind:'ascended'}),now);
 assert.equal(clean.maxLevel,30);assert.equal(clean.maxDepth,512);assert.equal(clean.turn,10_000_000);assert.equal(clean.endKind,'ascended');
 for(const forged of [
  {maxLevel:31},{heroLevel:31},{maxDepth:513},{turn:10_000_001},{turn:999_999_999},
  {heroLevel:5,maxLevel:4},{endKind:'won'},{endKind:''},
 ])assert.equal(sanitizeRun(run('forged',forged),now),null,JSON.stringify(forged));
 for(const unknown of [0,-1,1.5,Infinity,'6'])assert.equal(sanitizeRun(run('unknown',{maxLevel:unknown,heroLevel:unknown}),now).maxLevel,undefined);
 assert.equal(sanitizeRun(run('no-end',{endKind:undefined}),now).endKind,undefined);
});

test('ledger metadata is published only by the vault that registered the run, and stays bound to it',async t=>{
 t.mock.method(Date,'now',()=>now);
 const store=new MemoryStorage();const server=createTestHarness({store}),{url}=await server.listen();t.after(()=>server.close());
 const post=body=>fetch(new URL('/api/runs',url),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const register=(vault,ids)=>fetch(new URL('/api/vaults/'+vault+'/adventures',url),{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(ids.map(id=>run(id)))});
 assert.equal((await post({runs:[run('anon')]})).status,400,'no vault, no publication');
 assert.equal((await post({vault:'not-a-vault',runs:[run('anon')]})).status,400);
 assert.deepEqual(await(await post({vault:VAULT,runs:[run('unregistered')]})).json(),{stored:0,refused:1});
 assert.equal((await fetch(new URL('/api/runs/unregistered',url))).status,404);
 assert.equal((await register(VAULT,['mine'])).status,204);
 assert.deepEqual(await(await post({vault:VAULT,runs:[run('mine',{turn:10})]})).json(),{stored:1,refused:0});
 // Another vault registers the same public id and tries to overwrite it.
 assert.equal((await register(OTHER,['mine'])).status,204);
 assert.deepEqual(await(await post({vault:OTHER,runs:[run('mine',{turn:5000,maxLevel:30,ended:true,endKind:'ascended'})]})).json(),{stored:0,refused:1});
 const record=await(await fetch(new URL('/api/runs/mine',url))).json();
 assert.equal(record.turn,10);assert.equal(record.ended,false);assert.equal(record.endKind,undefined);
 assert.equal(JSON.stringify(record).includes(vaultOwner(VAULT)),false,'the owner digest is never published');
 assert.deepEqual(await(await post({vault:VAULT,runs:[run('mine',{turn:20})]})).json(),{stored:1,refused:0});
 assert.equal((await(await fetch(new URL('/api/runs/mine',url))).json()).turn,20);
 // Forged values inside an otherwise valid batch are refused individually.
 await register(VAULT,['bounded']);
 assert.deepEqual(await(await post({vault:VAULT,runs:[run('bounded',{maxLevel:50}),run('bounded',{maxLevel:3})]})).json(),{stored:1,refused:1});
 assert.equal((await(await fetch(new URL('/api/runs/bounded',url))).json()).maxLevel,3);
});

test('a record without an owner belongs to the vault that published its input archive',async t=>{
 t.mock.method(Date,'now',()=>now);
 const store=new MemoryStorage();
 await store.write('board/index.json',{runs:[{...run('legacy',{turn:50}),updatedAt:now-1}],errors:[]});
 await store.write('input-runs/archived.json',{owner:vaultOwner(VAULT),buildId:'b',count:1,generation:1,chunks:[],complete:false});
 await storageContext.run(store,async()=>{
  await saveLedgerRun({...run('archived',{turn:1}),updatedAt:now},vaultOwner(OTHER));
  assert.equal(await ledgerRun('archived'),null,'the archive uploader owns the run');
  assert.ok(await saveLedgerRun({...run('archived',{turn:1}),updatedAt:now},vaultOwner(VAULT)));
  assert.equal(await saveLedgerRun({...run('archived',{turn:2}),updatedAt:now},vaultOwner(OTHER)),null);
  assert.ok(await saveLedgerRun({...run('legacy',{turn:60}),updatedAt:now},vaultOwner(VAULT)),'an unarchived legacy record is claimed by its first publisher');
  assert.equal(await saveLedgerRun({...run('legacy',{turn:70}),updatedAt:now},vaultOwner(OTHER)),null);
  assert.equal((await ledgerRun('legacy')).turn,60);
  assert.ok(await saveLedgerRun({...run('legacy',{turn:80}),updatedAt:now}),'server-side writers carry no owner and never rebind one');
  assert.equal(await saveLedgerRun({...run('legacy',{turn:90}),updatedAt:now},vaultOwner(OTHER)),null);
 });
});

test('only runs with a public recording are ranked, counted as ascended or take records; recent runs list everything',async t=>{
 t.mock.method(Date,'now',()=>now);
 const store=new MemoryStorage();
 await storageContext.run(store,()=>publicReplayContext.run(publicStoreFor(store),async()=>{
  await saveLedgerRun({...run('claimed',{turn:9000,maxLevel:30,maxDepth:50,ended:true,endKind:'ascended'}),updatedAt:now});
  await saveLedgerRun({...run('played',{turn:300,maxLevel:4,maxDepth:6}),updatedAt:now+1});
  let stats=await ledgerStats();
  assert.deepEqual(stats.totals,{runs:2,living:1,ascended:0,longest:0});
  assert.deepEqual(stats.best,[]);assert.deepEqual(stats.recorded,[]);
  assert.deepEqual(stats.records.today.level,[]);assert.deepEqual(stats.records.week.depth,[]);
  assert.deepEqual(stats.recent.map(r=>r.id),['played','claimed']);assert.equal(stats.records.today.runs,2);
  await markRecorded('played');
  stats=await ledgerStats();
  assert.deepEqual(stats.totals,{runs:2,living:1,ascended:0,longest:300});
  assert.deepEqual(stats.best.map(r=>r.id),['played']);assert.equal(stats.best[0].replayAvailable,true);
  assert.deepEqual(stats.records.today.level.map(r=>r.id),['played']);assert.deepEqual(stats.records.week.depth.map(r=>r.id),['played']);
  assert.deepEqual(stats.recent.map(r=>r.id),['played','claimed'],'self-reported progress remains visible, unranked');
 }));
});
