import {test} from 'node:test';
import {withSessionViews,assertSceneObservation} from './mcp-view-fixture.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {startMcpHttp} from './mcp-fixture.mjs';
import {WasmTransport} from '../dist/typescript/wasm.js';
function sql(path,query){return JSON.parse(execFileSync('bun',['-e',`import {Database} from 'bun:sqlite';const db=new Database(process.argv[1]);const result=db.query(process.argv[2]).all();console.log(JSON.stringify(result));db.close();`,path,query],{encoding:'utf8'}));}
async function fixture(t){
  const sessionsPath=await mkdtemp('/tmp/mcp-recovery-');let server=await startMcpHttp({sessionsPath}),n=0;
  t.after(async()=>{await server.close();await rm(sessionsPath,{recursive:true,force:true});});
  return {sessionsPath,server:()=>server,db:id=>`${sessionsPath}/runs/${id}/journal.sqlite`,
    restart:async(kill=false,runtimePath)=>{if(kill){const exit=once(server.process,'exit');server.process.kill('SIGKILL');await exit;}else await server.close();server=await startMcpHttp({sessionsPath,runtimePath});},
    call:withSessionViews(async(name,args={})=>{const r=await fetch(server.url,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:++n,method:'tools/call',params:{name,arguments:args}})});const body=await r.json();assert.equal(r.status,200,JSON.stringify(body));return body.result.structuredContent;})};
}
for(const boundary of ['reserve','completion'])test('WASM disk journal survives actual SQLite '+boundary+' failure and process death',async t=>{
  const f=await fixture(t),created=await f.call('create',{role:'valkyrie',seed:42}),sid={sessionId:created.basis.sessionId},db=f.db(sid.sessionId);
  const trigger=boundary==='reserve'?"CREATE TRIGGER fail BEFORE INSERT ON inputs WHEN NEW.idx=1 BEGIN SELECT RAISE(FAIL,'test reservation failure'); END":"CREATE TRIGGER fail BEFORE UPDATE OF completion ON inputs WHEN NEW.idx=1 BEGIN SELECT RAISE(FAIL,'test completion failure'); END";
  sql(db,trigger);
  const failed=await f.call('search',{...sid,turns:1});assert.equal(failed.error.code,'uncertainExecution');assert.ok(failed.outcome.operationId);
  const follow=await f.call('search',{...sid,turns:1});assert.ok(follow.error,'uncertainty blocks another action');
  const rows=sql(db,'SELECT value,completion FROM inputs ORDER BY idx');assert.equal(rows.length,boundary==='reserve'?1:2);if(boundary==='completion')assert.equal(rows[1].completion,null);
  sql(db,'DROP TRIGGER fail');await f.restart(true);
  const restored=await f.call('resume',sid);assert.equal(restored.error,undefined,JSON.stringify(restored));
  assert.equal(restored.basis.turn,created.basis.turn+(boundary==='completion'?1:0));
  if(boundary==='completion'){
    const receipt=await f.call('receipt',{...sid,operationId:failed.outcome.operationId});assert.equal(receipt.result.receipt.outcome.turnsElapsed,1);assert.equal(receipt.result.receipt.observation.turn,restored.basis.turn);
    // Re-execute the durable prefix in a fresh isolated worker to verify the
    // exact reconstructed receipt, including original request/session identity.
    const reference=await WasmTransport.create();t.after(()=>reference.close());let expected;
    for(const row of rows)expected=await reference.playback({...JSON.parse(row.value),...(row.completion?JSON.parse(row.completion):{})});
    assert.deepEqual(receipt.result.receipt.observation,expected.observation);assert.deepEqual(receipt.result.receipt.outcome,expected.outcome);assert.deepEqual(receipt.result.receipt.events,expected.events);assert.equal(receipt.result.operationId,expected.requestId);
    const observed=await f.call('syncState',sid);assertSceneObservation(observed,expected.observation);assert.deepEqual(observed.scene.self,restored.scene.self);
    assert.equal(sql(db,'SELECT idx FROM inputs').length,2);
  }
});
test('crash restart retains exact standing question, receipt and original runtime despite changed default',async t=>{
  const f=await fixture(t),a=await f.call('create',{role:'valkyrie',seed:42}),sid={sessionId:a.basis.sessionId};
  const prayer=await f.call('pray',sid);await f.restart(true,f.sessionsPath+'/nonexistent-new-default');
  const resumed=await f.call('resume',sid);assert.deepEqual(resumed.decision,prayer.decision);assert.equal(resumed.basis.revision,prayer.basis.revision);
  const receiptObservation=(await f.call('receipt',{...sid,operationId:prayer.outcome.operationId})).result.receipt.observation;assertSceneObservation(prayer,receiptObservation);
  const pin=JSON.parse(await readFile(`${f.sessionsPath}/runs/${a.basis.sessionId}/runtime.json`));
  const manifest=JSON.parse(await readFile(`${f.sessionsPath}/runtimes/${pin.buildId}/manifest.json`));
  assert.equal(manifest.buildId,pin.buildId);
  // Published pins are verified, never silently replaced by current binaries.
  await f.restart();await writeFile(`${f.sessionsPath}/runtimes/${pin.buildId}/neonethack-core.wasm`,'corrupt');
  assert.ok((await f.call('resume',sid)).error);
});
test('two servers cannot own one disk journal; unrelated games remain usable',async t=>{
  const f=await fixture(t),a=await f.call('create',{role:'valkyrie',seed:9}),second=await startMcpHttp({sessionsPath:f.sessionsPath});
  t.after(()=>second.close());
  const response=await fetch(second.url,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'resume',arguments:{sessionId:a.basis.sessionId}}})});
  assert.match((await response.json()).result.structuredContent.error.message,/owns this WASM journal/);
  const b=await f.call('create',{role:'wizard',seed:7});assert.notEqual(a.basis.sessionId,b.basis.sessionId);
  assert.equal((await f.call('syncState',{sessionId:a.basis.sessionId})).basis.revision,a.basis.revision);
});
