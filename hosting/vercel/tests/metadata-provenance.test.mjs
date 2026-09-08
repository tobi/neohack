import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createTestHarness} from './server.mjs';

test('directory and ledger retain WebMCP use across delayed manual metadata without changing other fields',async()=>{
 const server=createTestHarness(),{url}=await server.listen();
 try {
  const vault=crypto.randomUUID(),id='metadata-handoff',pin='a'.repeat(64);
  const endpoint=new URL('/api/vaults/'+vault+'/adventures',url);
  const base={id,vaultId:vault,accountId:'fixture-owner',buildId:pin,recording:'inputs',name:'Hero',role:'valkyrie',turn:7,ended:false,control:'manual',automated:false,maxLevel:1};
  const headKey='input-runs/'+id+'.json',accountKey='accounts/fixture-owner/runs/'+id+'.json';
  await server.store.write(headKey,{owner:'fixed-upload-authority',buildId:pin,count:4,accountId:'fixture-owner'});
  await server.store.write(accountKey,{inputRun:id,run:{id,buildId:pin}});
  const head=await server.store.read(headKey),account=await server.store.read(accountKey);
  const publish=async run=>{
   assert.equal((await fetch(endpoint,{method:'PUT',body:JSON.stringify([run])})).status,204);
   assert.equal((await fetch(new URL('/api/runs',url),{method:'POST',body:JSON.stringify({runs:[run]})})).status,200);
  };
  const read=async()=>({directory:(await(await fetch(endpoint)).json())[0],ledger:await(await fetch(new URL('/api/runs/'+id,url))).json()});
  await publish(base);assert.equal((await read()).ledger.control,'manual');
  const agent={...base,control:'webmcp',automated:true};await publish(agent);
  const before=await read();assert.equal(before.directory.control,'webmcp');assert.equal(before.ledger.control,'webmcp');
  // The old snapshot was captured before the new owner published its same-turn update.
  await publish(base);const after=await read();
  assert.deepEqual(after.directory,agent);
  const {updatedAt:_before,...expectedLedger}=before.ledger;
  const {updatedAt:_after,...actualLedger}=after.ledger;
  assert.deepEqual(actualLedger,expectedLedger);
  await publish({...base,turn:6,name:'stale'});assert.deepEqual(await read(),after);
  // Sticky provenance does not block legitimate later progress or display changes.
  await publish({...base,turn:8,name:'Later'});const later=await read();
  assert.deepEqual(later.directory,{...agent,turn:8,name:'Later'});
  assert.equal(later.ledger.control,'webmcp');assert.equal(later.ledger.automated,true);assert.equal(later.ledger.turn,8);
  assert.deepEqual(await server.store.read(headKey),head);assert.deepEqual(await server.store.read(accountKey),account);
  assert.equal(later.ledger.buildId,pin);assert.equal(later.ledger.id,id);
 }finally{await server.close()}
});

test('mixed script, bot and playground control labels keep existing replacement behavior',async()=>{
 const server=createTestHarness(),{url}=await server.listen();
 try {
  const endpoint=new URL('/api/vaults/'+crypto.randomUUID()+'/adventures',url);
  for(const [from,to] of [['webmcp','script'],['webmcp','bot'],['webmcp','playground'],['script','manual'],['bot','manual'],['playground','manual']]){
   const id=from+'-'+to;
   for(const control of [from,to]){
    const run={id,name:'Hero',role:'valkyrie',turn:1,ended:false,control,automated:control!=='manual'};
    assert.equal((await fetch(endpoint,{method:'PUT',body:JSON.stringify([run])})).status,204);
    assert.equal((await fetch(new URL('/api/runs',url),{method:'POST',body:JSON.stringify({runs:[run]})})).status,200);
   }
   const directory=(await(await fetch(endpoint)).json()).find(r=>r.id===id),ledger=await(await fetch(new URL('/api/runs/'+id,url))).json();
   for(const run of [directory,ledger]){assert.equal(run.control,to);assert.equal(run.automated,to!=='manual')}
  }
 }finally{await server.close()}
});
