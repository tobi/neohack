import {test}from'node:test';
import assert from'node:assert/strict';
import {MemoryStorage}from'./server.mjs';
import{storageContext,Conflict}from'../src/storage.ts';
import{recoverLedger}from'../scripts/recover-ledger.mjs';
const run=(id,turn=1)=>({id,name:'Hero',role:'wizard',turn,ended:false,updatedAt:100});
test('ledger recovery is dry-run by default, additive, repeatable and preserves original records',async()=>{
 const store=new MemoryStorage();await store.write('board/runs.json',[run('old'),run('shared',2)]);
 const current={runs:[{...run('shared',99),ended:true}],errors:[{code:'network'}]};await store.write('board/index.json',current);
 await storageContext.run(store,async()=>{
  const revision=store.revision;assert.equal((await recoverLedger()).added,1);assert.equal(store.revision,revision);
  const source=await store.read('board/runs.json');assert.equal((await recoverLedger({apply:true})).total,2);
  const doc=(await store.read('board/index.json')).value;
  assert.deepEqual(doc.runs.find(r=>r.id==='shared'),current.runs[0]);assert.deepEqual(doc.errors,current.errors);
  assert.deepEqual(await store.read('board/runs.json'),source);
  const after=store.revision;assert.equal((await recoverLedger({apply:true})).added,0);assert.equal(store.revision,after);
 });
});
test('invalid recovery source never writes and concurrent live updates survive retry',async()=>{
 const store=new MemoryStorage();await store.write('board/runs.json',[{id:'bad'}]);
 await storageContext.run(store,async()=>{
  const before=store.revision;await assert.rejects(recoverLedger({apply:true}),/invalid/);assert.equal(store.revision,before);
  await store.write('board/runs.json',[run('old')],(await store.read('board/runs.json')).etag);
  const write=store.write.bind(store);let raced=false;
  store.write=async(path,value,etag)=>{if(path==='board/index.json'&&!raced){raced=true;await write(path,{runs:[run('live',100)],errors:[]});throw new Conflict();}return write(path,value,etag);};
  assert.equal((await recoverLedger({apply:true})).total,2);
  assert.deepEqual((await store.read('board/index.json')).value.runs.map(r=>r.id).sort(),['live','old']);
 });
});

test('historical recovery also fills the partitioned ledger without changing its source',async()=>{
 const {saveLedgerRun,ledgerStats}=await import('../src/ledger-store.ts');
 const store=new MemoryStorage();await store.write('board/runs.json',[run('old'),run('shared',1)]);
 await storageContext.run(store,async()=>{
  await saveLedgerRun(run('shared',50));const revision=store.revision;
  const report=await recoverLedger();assert.equal(report.added,1);assert.equal(store.revision,revision);
  await recoverLedger({apply:true});const stats=await ledgerStats();assert.equal(stats.totals.runs,2);assert.equal(stats.recent.find(r=>r.id==='shared').turn,50);
  assert.equal((await store.read('board/runs.json')).value[1].turn,1);
 });
});
