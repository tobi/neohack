import assert from 'node:assert/strict';
import {test} from 'node:test';
import {decodeCheckpoint,encodeCheckpoint} from '../../../lib/neonethack/wasm/checkpoint-codec.mjs';
import {chromium} from '../../../web/neohack.dev/node_modules/playwright-core/index.mjs';
import {createTestHarness} from './server.mjs';
test('cloud checkpoints skip a genuine level prefix; cache failures replay inputs and interrupted inputs resume safely',{timeout:120000},async t=>{
const server=createTestHarness(),{url}=await server.listen(),browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,chromiumSandbox:true});
const timer=setTimeout(()=>void browser.close(),120000);let phase='live';const replayed={};
try {
 const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
 await context.route('**/core-worker.mjs',async route=>{const response=await route.fetch();const body=(await response.text()).replace('async function replayRecord(record) {',"async function replayRecord(record) { console.log('AUDIT_REPLAY '+record.index);");await route.fulfill({response,body});});
 page.on('console',m=>{const s=m.text();if(s.startsWith('AUDIT_PHASE ')){phase=s.slice(12);replayed[phase]=[]}if(s.startsWith('AUDIT_REPLAY '))(replayed[phase]??=[]).push(Number(s.slice(13)))});
 let wrong;const firstChunks=new Map();
 await context.route('**/replay-files/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  const response=await route.fetch();
  if(path.includes('/manifest') && phase==='cloudMissing'){
   const manifest=await response.json();delete manifest.checkpoints;return route.fulfill({response,json:manifest});
  }
  if(path.includes('/manifest') && ['cloudWrongPin','cloudWrongIndex'].includes(phase)){
   const manifest=await response.json(),entry=manifest.checkpoints[0];
   const bytes=new Uint8Array(await(await fetch(new URL(entry.path,route.request().url()))).arrayBuffer());
   const value=await decodeCheckpoint(bytes,entry.sha256);
   if(phase==='cloudWrongPin')value.buildId='0'.repeat(64);else value.index++;
   wrong=await encodeCheckpoint(value);entry.sha256=wrong.sha256;entry.bytes=wrong.bytes.length;entry.path='checkpoints/'+wrong.sha256+'.gz';
   return route.fulfill({response,json:manifest});
  }
  if(path.includes('/checkpoints/')){
   if(phase==='cloudUnavailable')return route.fulfill({status:404,body:'Not found'});
   if(phase==='cloudCorrupt')return route.fulfill({response,body:Buffer.from('corrupt optional checkpoint')});
   if(['cloudWrongPin','cloudWrongIndex'].includes(phase))return route.fulfill({status:200,body:Buffer.from(wrong.bytes)});
  }
  if(path.includes('/chunks/') && ['cloudInterrupted','cloudCorruptInput'].includes(phase)){
   // Reject the second chunk only, after the first genuine level prefix is durable.
   if(firstChunks.has(phase) && path!==firstChunks.get(phase))return route.fulfill({status:phase==='cloudInterrupted'?503:200,body:'Broken authoritative input chunk'});
   firstChunks.set(phase,path);
  }
  await route.fulfill({response});
 });
 await page.goto(url.href);
 const result=await page.evaluate(async()=>{
  const {WasmTransport}=await import('/runtime/typescript/wasm.js'),{Neonethack}=await import('/runtime/typescript/client.js'),{buildId}=await(await fetch('/runtime/wasm/current.json')).json(),base='/runtime/wasm/'+buildId+'/';
  const {openProtocolStore}=await import(base+'protocol-store.mjs'),{inputRecords}=await import(base+'protocol-reader.mjs');
  const vault=crypto.randomUUID(),storage={kind:'journal',name:'level-'+crypto.randomUUID(),uploadUrl:new URL('/api/runs/',location.href).href,uploadToken:vault,archiveConfigUrl:new URL('/replay-config.json',location.href).href};
  const opts={storage,workerUrl:new URL(base+'core-worker.mjs',location.href),registerUpload:async(id,signal)=>{const r=await fetch('/api/vaults/'+vault+'/adventures',{method:'PUT',signal,body:JSON.stringify([{id,buildId,name:'Stairs',role:'valkyrie',turn:1,ended:false,control:'manual'}])});if(!r.ok)throw Error('register failed')}};
  let transport=await WasmTransport.create(opts),api=new Neonethack(transport),game=await api.create({role:'valkyrie',seed:2,name:'Stairs'});
  const id=game.id,startLevel=game.observation.location.id,startTurn=game.observation.turn;
  for(let n=0;n<100&&game.observation.location.id===startLevel&&!game.state.ended&&!game.decision;n++){
   let r=await game.descend({maxActions:30});if(r.reason==='noRoute')r=await game.explore({maxActions:30});if(!r.actionsTaken)break;
  }
  if(game.observation.location.id===startLevel)throw Error('Did not reach a new level');
  const store=await openProtocolStore(storage.name);let cp;
  for(let n=0;n<200&&!cp;n++){cp=await store.checkpoint(id);if(!cp)await new Promise(r=>setTimeout(r,20))}if(!cp)throw Error('No genuine checkpoint');
  await transport.flushRecording(id);
  // Explicit decision/cancel suffix preserves the scene and standing final question.
  for(let n=0;n<12;n++){await game.pray();if(game.decision?.kind!=='confirmation')throw Error('No prayer confirmation');await game.cancel(game.decision.id)}await game.pray();
  const expected=game.state,header=await store.header(id),records=[];for(let from=0;from<header.count;from+=128)records.push(...await store.range(id,from,128));
  const historic=records[1].request.params.requestId,receiptReq={version:1,method:'session.receipt',params:{sessionId:id,requestId:historic}},exactReceipt=await transport.send(receiptReq);
  const ack=await transport.flushRecording(id),manifestUrl=ack.manifest,manifest=await(await fetch(manifestUrl)).json();if(!manifest.checkpoints.length)throw Error('Checkpoint not published');await api.close();
  const scene=s=>{const {requestId,outcome,...rest}=s;return rest},equal=(a,b)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw Error('Comparison differs in '+window.phase)},rows=[];
  const begin=p=>{window.phase=p;console.log('AUDIT_PHASE '+p);return performance.now()};
  let t=begin('local');transport=await WasmTransport.create(opts);const opened=performance.now();api=new Neonethack(transport);game=await api.resume(id);equal(scene(game.state),scene(expected));rows.push({phase:'local',openMs:opened-t,resumeMs:performance.now()-opened});
  begin('localReceipt');equal(await transport.send(receiptReq),exactReceipt);await api.close();
  t=begin('full');transport=await WasmTransport.create({workerUrl:opts.workerUrl});let whole;for(const record of records)whole=await transport.playback(record);equal(whole,expected);rows.push({phase:'full',totalMs:performance.now()-t});equal(await transport.send(receiptReq),exactReceipt);await transport.close();
  for(const mode of ['cloud','cloudMissing','cloudUnavailable','cloudCorrupt','cloudWrongPin','cloudWrongIndex','cloudInterrupted','cloudCorruptInput']){
   t=begin(mode);const cloudOptions={...opts,storage:{...storage,name:mode+'-'+crypto.randomUUID(),...(['cloudMissing','cloudWrongPin','cloudWrongIndex'].includes(mode)?{uploadUrl:undefined}:{})}};
   transport=await WasmTransport.create(cloudOptions);const cloudOpen=performance.now();api=new Neonethack(transport);
   if(['cloudInterrupted','cloudCorruptInput'].includes(mode)){
    let failed=false;try{await api.resume(id)}catch{failed=true}if(!failed)throw Error('Interrupted inputs were accepted');
    await api.close();const partial=await openProtocolStore(cloudOptions.storage.name),h=await partial.header(id);
    if(h.count!==cp.index||!h.importing||await partial.checkpoint(id))throw Error('Partial import not retained safely');partial.close();
    begin(mode+'Recovered');transport=await WasmTransport.create(cloudOptions);api=new Neonethack(transport);
   }
   game=await api.resume(id);equal(scene(game.state),scene(expected));rows.push({phase:mode,openMs:cloudOpen-t,resumeMs:performance.now()-cloudOpen});
   begin(mode+'Receipt');equal(await transport.send(receiptReq),exactReceipt);await api.close();
  }
  // Static archive restore and seek: all network requests in this phase are static.
  t=begin('static');transport=await WasmTransport.create({workerUrl:opts.workerUrl,playbackArchive:{manifest,url:manifestUrl}});const c=manifest.checkpoints[0],bytes=new Uint8Array(await(await fetch(new URL(c.path,manifestUrl))).arrayBuffer());await transport.restoreCheckpointBytes({bytes,sha256:c.sha256,index:c.index});let last;
  for await(const record of inputRecords(manifest,manifestUrl,{from:c.index}))last=await transport.playback(record);
  equal(last,expected);rows.push({phase:'static',totalMs:performance.now()-t});begin('staticReceipt');equal(await transport.send(receiptReq),exactReceipt);await transport.close();store.close();
  return {source:'cloud-checkpoint working tree',buildId,seed:2,role:'valkyrie',startLevel,endLevel:expected.observation.location.id,actualTurns:expected.observation.turn-startTurn,turn:expected.observation.turn,inputs:header.count,checkpoint:{index:cp.index,turn:cp.turn,bytes:cp.bytes.length},suffix:header.count-cp.index,receiptIndex:1,rows,allComparisonsExact:true};
 });
 const suffix=Array.from({length:result.suffix},(_,i)=>result.checkpoint.index+i),full=Array.from({length:result.inputs},(_,i)=>i);
 for(const phase of ['local','cloud','cloudInterruptedRecovered','cloudCorruptInputRecovered','static'])assert.deepEqual(replayed[phase],suffix,phase+' replays suffix only');
 for(const phase of ['full','cloudMissing','cloudUnavailable','cloudCorrupt','cloudWrongPin','cloudWrongIndex'])assert.deepEqual(replayed[phase],full,phase+' replays the authoritative log');
 for(const phase of ['cloudInterrupted','cloudCorruptInput'])assert.deepEqual(replayed[phase],[],'input failure cannot start checkpoint or engine replay');
 t.diagnostic(JSON.stringify({...result,replayed}));
}finally{clearTimeout(timer);await browser.close();await server.close()}

});
