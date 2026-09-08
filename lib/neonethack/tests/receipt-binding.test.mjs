import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {fixture,identity} from './native-fixture.mjs';

test('private receipt checkpoint rejects changed historical text without changing source journals',async t=>{
  const b=await fixture(t),game=await b.api.create(identity);
  const result=await b.transport.send({version:1,method:'game.search',params:{sessionId:game.id,requestId:'binding-probe',expectedRevision:game.state.revision}});
  assert.equal(result.error,undefined,JSON.stringify(result.error));
  await game.close();
  const root=`${b.sessions}/${game.id}`,rng=await readFile(root+'/rng.jsonl','utf8');
  const input=await readFile(root+'/input.log.jsonl','utf8');
  const file=root+'/perceptions.jsonl';let count=0;
  const original=await readFile(file,'utf8');
  const altered=original.trimEnd().split('\n').map(line=>{
    const r=JSON.parse(line);
    if(r.response.requestId==='binding-probe'){
      r.response.observation.heard=['Altered historical text.'];count++;return JSON.stringify(r);
    }
    return line;
  }).join('\n')+'\n';
  assert.equal(count,1);await writeFile(file,altered);
  const next=await fixture(t,{sessions:b.sessions});
  const resume=await next.transport.send({version:1,method:'session.resume',params:{sessionId:game.id}});
  assert.ok(resume.error,'changed historical receipt must not resume successfully');
  assert.equal(await readFile(file,'utf8'),altered,'rejection must preserve suspect bytes');
  assert.equal(await readFile(root+'/rng.jsonl','utf8'),rng);
  assert.equal(await readFile(root+'/input.log.jsonl','utf8'),input);
  await next.transport.close();
  await writeFile(file,original);
  const recovered=await fixture(t,{sessions:b.sessions});
  const restored=await recovered.transport.send({version:1,method:'session.resume',params:{sessionId:game.id}});
  assert.equal(restored.error,undefined,JSON.stringify(restored.error));
  const receipt=await recovered.transport.send({version:1,method:'session.receipt',params:{sessionId:game.id,requestId:'binding-probe'}});
  assert.deepEqual(receipt,result,'restoring exact original bytes preserves exact receipt');
});
