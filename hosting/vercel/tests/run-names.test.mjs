import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MemoryStorage} from './server.mjs';
import {storageContext} from '../src/storage.ts';
import {publicReplayContext} from '../src/public-replay-store.ts';
import {saveLedgerRun,ledgerRun,ledgerStats,markChronicled,markRecorded,renameLedgerRun} from '../src/ledger-store.ts';
import {renamePublicRun} from '../src/run-name-maintenance.ts';
import {sanitizeRun} from '../src/board.ts';
import {adventurerName,generatedName,publicName} from '../../../web/neohack.dev/src/adventurer-names.mjs';
import {displayText,displayDocument} from '../../../web/neohack.dev/src/public-names.mjs';

test('public creation metadata admits generated names, not arbitrary names or forged corrections',()=>{
 const name=adventurerName();assert.ok(generatedName(name));assert.notEqual(adventurerName(name),name);
 const run=sanitizeRun({id:'name-test',turn:1,name:'<img src=x onerror=alert(1)>',nameOverride:{original:'x',name:'Forged'}},1);
 assert.equal(run.name,publicName(run.id,'anything'));assert.ok(generatedName(run.name));assert.equal(run.nameOverride,undefined);
 assert.equal(sanitizeRun({...run,name},1).name,name);
});

test('metadata indexed after an operator correction cannot restore the old name',async()=>{
 const store=new MemoryStorage();
 await storageContext.run(store,async()=>{
  const run={id:'delayed-name',name:'Bad Johnson',role:'wizard',turn:3,updatedAt:1,ended:false};
  let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
  const write=store.write.bind(store);let held=false;
  store.write=async(path,value,etag)=>{await write(path,value,etag);if(path==='ledger/runs/'+run.id+'.json'&&!held){held=true;entered();await gate;}};
  const old=saveLedgerRun(run);
  try{await started;await renameLedgerRun(run.id,run.name,'Nick Johnson');}
  finally{release();await old;}
  assert.equal((await ledgerRun(run.id)).name,'Nick Johnson');assert.equal((await ledgerStats()).best[0].name,'Nick Johnson');
 });
});

test('display correction is literal, preserves input data and handles names without markup interpretation',()=>{
 const input={text:'Bad Johnson met Bad. Badger stayed.',hash:'abc',turn:1};
 const corrected=displayDocument(input,{original:'Bad Johnson',name:'Nick Johnson'});
 assert.equal(corrected.text,'Nick Johnson met Nick. Badger stayed.');assert.equal(input.text,'Bad Johnson met Bad. Badger stayed.');
 assert.equal(displayText('A.* Smith and Axx Smith',{original:'A.* Smith',name:'Nick Johnson'}),'Nick Johnson and Axx Smith');
 assert.equal(displayText('<img src=x> Bad',{original:'Bad',name:'Nick'}),'<img src=x> Nick');
 assert.equal(displayText('Bad',{original:'Bad',name:'<script>'}),'Bad');
});

test('operator rename preserves exact replay descriptors, metadata, availability and later syncs',async()=>{
 const store=new MemoryStorage(),pub=new MemoryStorage(),id='renameTest123456';
 await storageContext.run(store,()=>publicReplayContext.run(pub,async()=>{
  const run={id,name:'Bad Johnson',role:'wizard',turn:42,ended:true,endKind:'death',updatedAt:123,maxDepth:3,maxLevel:4};
  const head={buildId:'a'.repeat(64),count:10,generation:2,chunks:[{path:'unchanged.gz',hash:'b'.repeat(64),from:0,count:10}],checkpoints:[{index:8,path:'checkpoint.gz'}],complete:true,owner:'private',ack:10};
  await store.write('input-runs/'+id+'.json',head);await saveLedgerRun(run);await markRecorded(id);await markChronicled(id);
  const story={hero:{name:run.name},story:{title:'Bad Johnson and the cat',paragraphs:[{text:'Bad fell.',sources:['T42']}]},evidenceHash:'c'.repeat(64)};
  await pub.write('chronicles/'+id+'/story.json',story);
  const totals=(await ledgerStats()).totals;
  await renamePublicRun(id,run.name,'Nick Johnson');await renamePublicRun(id,run.name,'Nick Johnson');
  const changed=(await store.read('input-runs/'+id+'.json')).value;
  const {nameOverride,generation,...unchanged}=changed;
  assert.deepEqual(unchanged,((({generation,...v})=>v)(head)));assert.equal(generation,3);
  const manifest=(await pub.read('replays/'+id+'/manifest.json')).value;
  assert.deepEqual(manifest.chunks,head.chunks);assert.deepEqual(manifest.checkpoints,head.checkpoints);assert.deepEqual(manifest.nameOverride,nameOverride);
  await saveLedgerRun({...run,updatedAt:124});
  assert.equal((await ledgerRun(id)).name,'Nick Johnson');
  const stats=await ledgerStats();assert.deepEqual(stats.totals,totals);assert.equal(stats.best[0].name,'Nick Johnson');
  assert.equal(stats.best[0].replayAvailable,true);assert.equal(stats.best[0].chronicleAvailable,true);
  const tale=(await pub.read('chronicles/'+id+'/story.json')).value;
  assert.equal(tale.story.title,'Nick Johnson and the cat');assert.equal(tale.story.paragraphs[0].text,'Nick fell.');assert.equal(tale.evidenceHash,story.evidenceHash);
  await assert.rejects(renamePublicRun(id,'Different','Other Hero'),/name changed/);
 }));
});
