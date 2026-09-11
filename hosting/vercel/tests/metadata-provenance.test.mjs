import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createTestHarness} from './server.mjs';
import {vaultOwner} from '../src/ledger-store.ts';

test('directory and ledger retain WebMCP use across delayed manual metadata without changing other fields',async()=>{
 const server=createTestHarness(),{url}=await server.listen();
 try {
  const vault=crypto.randomUUID(),id='metadata-handoff',pin='a'.repeat(64);
  const endpoint=new URL('/api/vaults/'+vault+'/adventures',url);
  const base={id,vaultId:vault,accountId:'fixture-owner',buildId:pin,recording:'inputs',name:'Hero',role:'valkyrie',turn:7,ended:false,control:'manual',automated:false,maxLevel:1};
  const headKey='input-runs/'+id+'.json',accountKey='accounts/fixture-owner/runs/'+id+'.json';
  await server.store.write(headKey,{owner:vaultOwner(vault),buildId:pin,count:4,accountId:'fixture-owner'});
  await server.store.write(accountKey,{inputRun:id,run:{id,buildId:pin}});
  const head=await server.store.read(headKey),account=await server.store.read(accountKey);
  const publish=async run=>{
   assert.equal((await fetch(endpoint,{method:'PUT',body:JSON.stringify([run])})).status,204);
   assert.equal((await fetch(new URL('/api/runs',url),{method:'POST',body:JSON.stringify({vault,runs:[run]})})).status,200);
  };
  const read=async()=>({directory:(await(await fetch(endpoint)).json())[0],ledger:await(await fetch(new URL('/api/runs/'+id,url))).json()});
  await publish(base);assert.equal((await read()).ledger.control,'manual');
  const agent={...base,control:'webmcp',automated:true,webmcpAutomated:true,harness_name:'Pi',model_name:'Muse Spark'};await publish(agent);
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
  const vault=crypto.randomUUID(),endpoint=new URL('/api/vaults/'+vault+'/adventures',url);
  for(const [from,to] of [['webmcp','script'],['webmcp','bot'],['webmcp','playground'],['script','manual'],['bot','manual'],['playground','manual']]){
   const id=from+'-'+to;
   for(const control of [from,to]){
    const run={id,name:'Hero',role:'valkyrie',turn:1,ended:false,control,automated:control!=='manual'};
    assert.equal((await fetch(endpoint,{method:'PUT',body:JSON.stringify([run])})).status,204);
    assert.equal((await fetch(new URL('/api/runs',url),{method:'POST',body:JSON.stringify({vault,runs:[run]})})).status,200);
   }
   const directory=(await(await fetch(endpoint)).json()).find(r=>r.id===id),ledger=await(await fetch(new URL('/api/runs/'+id,url))).json();
   const stats=await(await fetch(new URL('/api/stats',url))).json();
   for(const run of [directory,ledger,stats.recent.find(run=>run.id===id)]){assert.equal(run.control,to);assert.equal(run.automated,to!=='manual')}
  }
 }finally{await server.close()}
});

test('equal-timestamp delayed indexing agrees with the authoritative WebMCP record',async t=>{
 t.mock.method(Date,'now',()=>1788840000000);
 const server=createTestHarness(),{url}=await server.listen();
 let release;const gate=new Promise(resolve=>release=resolve);
 let entered;const paused=new Promise(resolve=>entered=resolve);
 const id='projection-tie',write=server.store.write.bind(server.store);
 let held=false;
 server.store.write=async(path,value,etag)=>{
  await write(path,value,etag);
  if(!held && path==='ledger/runs/'+id+'.json' && value.run.control==='manual'){
   held=true;entered();await gate;
  }
 };
 let old;
 try {
  const vault=crypto.randomUUID();
  await fetch(new URL('/api/vaults/'+vault+'/adventures',url),{method:'PUT',body:JSON.stringify([{id}])});
  const publish=control=>fetch(new URL('/api/runs',url),{method:'POST',body:JSON.stringify({vault,runs:[{id,name:'Hero',role:'valkyrie',turn:7,ended:false,control,automated:control!=='manual',buildId:'a'.repeat(64)}]})});
  old=publish('manual');await paused;
  assert.equal((await publish('webmcp')).status,200);
  release();assert.equal((await old).status,200);
  const record=await(await fetch(new URL('/api/runs/'+id,url))).json();
  const stats=await(await fetch(new URL('/api/stats',url))).json();
  const shard=[...server.store.docs.entries()].filter(([path])=>path.startsWith('ledger/shards/')).map(([,doc])=>doc.value.entries[id]?.run).find(Boolean);
  t.diagnostic(JSON.stringify({updatedAt:record.updatedAt,record:record.control,shard:shard.control,summary:stats.recent.find(run=>run.id===id).control}));
  assert.equal(record.updatedAt,1788840000000);
  for(const run of [record,shard,stats.recent.find(run=>run.id===id)]){
   assert.equal(run.control,'webmcp');assert.equal(run.automated,true);
   assert.equal(run.id,id);assert.equal(run.turn,7);assert.equal(run.buildId,'a'.repeat(64));
  }
 }finally{release();await old;await server.close()}
});

test('late attribution enriches directory, ledger and summaries without rolling progress back', async () => {
 const server=createTestHarness(),{url}=await server.listen();
 try {
  const vault=crypto.randomUUID(),endpoint=new URL('/api/vaults/'+vault+'/adventures',url),id='late-attribution';
  const publish=async run=>{
   assert.equal((await fetch(endpoint,{method:'PUT',body:JSON.stringify([run])})).status,204);
   assert.equal((await fetch(new URL('/api/runs',url),{method:'POST',body:JSON.stringify({vault,runs:[run]})})).status,200);
  };
  const live={id,name:'Hero',role:'wizard',turn:20,ended:true,control:'manual',automated:false};
  await publish(live);
  await publish({...live,turn:1,ended:false,control:'webmcp',harness_name:'Pi',model_name:'Muse\nSpark'});
  await publish({...live,turn:21,control:'script',webmcpAutomated:false,harness_name:'Replacement',model_name:'Replacement'});
  const directory=(await(await fetch(endpoint)).json())[0],ledger=await(await fetch(new URL('/api/runs/'+id,url))).json();
  const stats=await(await fetch(new URL('/api/stats',url))).json();
  for(const r of [directory,ledger,stats.recent.find(r=>r.id===id)]) {
   assert.equal(r.turn,21);assert.equal(r.ended,true);assert.equal(r.control,'script');
   assert.equal(r.webmcpAutomated,true);assert.equal(r.automated,true);
   assert.equal(r.harness_name,'Pi');assert.equal(r.model_name,'MuseSpark');
  }
 } finally {await server.close()}
});
