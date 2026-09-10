import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mcpClient} from './mcp-client-fixture.mjs';
import {identity} from './native-fixture.mjs';
test('a blocked SQLite writer cannot block another game worker',async t=>{
  const f=await mcpClient(t,'http'),a=await f.call('create',identity),b=await f.call('create',{...identity,seed:7});
  const locker=spawn('bun',['-e',`import {Database} from 'bun:sqlite';const db=new Database(process.argv[1]);db.exec('BEGIN IMMEDIATE');console.log('locked');for await(const chunk of process.stdin){break;}db.exec('ROLLBACK');db.close();`,`${f.directory}/runs/${a.sessionId}/journal.sqlite`],{stdio:'pipe'});
  const exit=once(locker,'exit');t.after(async()=>{locker.stdin.end();await exit;});
  let waiting,completed;
  try {
    await once(locker.stdout,'data');
    waiting=f.call('search',{sessionId:a.sessionId,turns:1}).then(r=>{completed=r;return r;});
    const other=await f.call('search',{sessionId:b.sessionId,turns:1});
    assert.equal(other.error,undefined,JSON.stringify(other));
    assert.equal(completed,undefined,`other game must complete while first journal cannot write: ${JSON.stringify({blocked:completed,other})}`);
  } finally {
    // Release the lock before the fixture's server-close hook, also on failure.
    // Otherwise graceful shutdown waits for a worker whose lock we still hold.
    locker.stdin.end();assert.deepEqual(await exit,[0,null]);
  }
  const result=await waiting;assert.equal(result.error,undefined);assert.equal(result.outcome.turnsElapsed,1);
});
test('lost HTTP response retains one accepted input and recovery is read-only',async t=>{
  const f=await mcpClient(t,'http'),a=await f.call('create',identity),sid={sessionId:a.sessionId};
  // A real client loses the reply after the server has completed it. The client
  // sees no operation ID, then reads current state without guessing a receipt.
  let hidden;
  const send=fetch(f.server().url,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:991,method:'tools/call',params:{name:'search',arguments:{...sid,turns:1}}})});
  const wire=await send;hidden=(await wire.json()).result.structuredContent;
  const recovered=await f.call('observe',sid);assert.equal(recovered.verification,undefined);
  assert.equal(hidden.outcome.turnsElapsed,1);assert.equal(recovered.observation.turn,a.observation.turn+1);
  assert.equal((await f.call('observe',sid)).observation.turn,recovered.observation.turn);
  await f.restart();await f.call('resume',sid);
  const exact=await f.call('receipt',{...sid,operationId:hidden.operationId});
  assert.equal(exact.observation,undefined);assert.deepEqual(exact.receipt.outcome,hidden.outcome);
  assert.equal(exact.receipt.observation.turn,recovered.observation.turn);
});
