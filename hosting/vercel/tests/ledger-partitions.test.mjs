import {test} from 'node:test';import assert from 'node:assert/strict';
import {MemoryStorage} from './server.mjs';import {storageContext} from '../src/storage.ts';
import {ledgerStats,ledgerRun,saveLedgerRun,rebuildLedgerSummaries} from '../src/ledger-store.ts';
const run=(id,turn)=>({id,name:'Hero',role:'wizard',turn,ended:false,maxLevel:1,updatedAt:turn});
test('partitioned ledger preserves published records and rebuilds bounded summaries',async()=>{
 const store=new MemoryStorage();await store.write('board/index.json',{runs:[run('published',100)],errors:[]});const original=await store.read('board/index.json');
 await storageContext.run(store,async()=>{
  await ledgerStats();
  await Promise.all(Array.from({length:24},(_,i)=>saveLedgerRun(run('new-'+i,i+1))));
  const stats=await ledgerStats();assert.equal(stats.totals.runs,25);assert.equal(stats.totals.longest,100);
  assert.deepEqual(await store.read('board/index.json'),original);
  await saveLedgerRun({...run('published',120),ended:true});await saveLedgerRun(run('published',121));
  assert.equal((await ledgerRun('published')).turn,120);assert.equal((await ledgerRun('published')).ended,true);
  for(const path of await store.list('ledger/summaries/'))store.docs.delete(path);
  await rebuildLedgerSummaries();assert.equal((await ledgerStats()).totals.runs,25);
  const reads=[];const read=store.read.bind(store);store.read=async path=>{reads.push(path);return read(path);};await ledgerStats();
  assert.ok(reads.every(p=>p.startsWith('ledger/summaries/')),'stats reads bounded summaries only');assert.equal(reads.length,32);
 });
});

test('a failed summary write retains its independent run record and rebuild recovers it',async()=>{
 const store=new MemoryStorage();await storageContext.run(store,async()=>{
  await ledgerStats();const write=store.write.bind(store);let fail=true;
  store.write=async(path,value,etag)=>{if(fail&&path.startsWith('ledger/summaries/'))throw Error('summary interrupted');return write(path,value,etag);};
  await assert.rejects(saveLedgerRun(run('retained',33)),/interrupted/);
  assert.equal((await ledgerRun('retained')).turn,33);
  fail=false;await rebuildLedgerSummaries();assert.equal((await ledgerStats()).totals.runs,1);
 });
});
