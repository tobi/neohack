import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handler} from '../api/index.ts';
import {storageContext} from '../src/storage.ts';
import {MemoryStorage} from './server.mjs';

test('client reports reach structured Vercel logs without storage or private fields', async t => {
  const logs=[];t.mock.method(console,'warn',entry=>logs.push(JSON.parse(entry)));
  const store=new MemoryStorage();let reads=0,writes=0;
  store.read=async()=>{reads++;throw Error('PRIVATE storage unavailable');};
  store.write=async()=>{writes++;throw Error('PRIVATE');};
  await storageContext.run(store,async()=>{
    const request=body=>new Request('https://example.test/api/errors',{method:'POST',body:JSON.stringify(body)});
    assert.equal((await handler(request({code:'network',buildId:'a'.repeat(64),message:'PRIVATE',url:'PRIVATE',stack:'PRIVATE',vault:'PRIVATE'}))).status,204);
    assert.equal((await handler(request({code:'PRIVATE'}))).status,400);
    assert.equal((await handler(request({code:'network',buildId:'PRIVATE'}))).status,400);
    assert.equal((await handler(new Request('https://example.test/api/errors'))).status,405);
  });
  assert.deepEqual(logs,[{event:'client_diagnostic',code:'network',buildId:'a'.repeat(64)}]);
  assert.equal(reads,0);assert.equal(writes,0);
});

test('failed API requests log safe route templates and status, including rewritten routes',async t=>{
  const logs=[];t.mock.method(console,'error',entry=>logs.push(JSON.parse(entry)));
  const store=new MemoryStorage();store.read=async()=>{throw new TypeError('PRIVATE token storage path');};
  await storageContext.run(store,async()=>{
    for(const url of ['https://example.test/api/vaults/12345678-1234-4234-8234-123456789abc?token=PRIVATE','https://example.test/api?__path=vaults/12345678-1234-4234-8234-123456789abc&token=PRIVATE']){
      assert.equal((await handler(new Request(url))).status,503);
    }
  });
  assert.equal(logs.length,2);
  for(const log of logs){assert.equal(log.event,'request_failed');assert.equal(log.route,'/api/vaults/:vault');assert.equal(log.status,503);assert.equal(log.code,'storage_unavailable');assert.equal(log.kind,'TypeError');assert.ok(log.durationMs>=0);}
  assert.ok(!JSON.stringify(logs).includes('PRIVATE'));assert.ok(!JSON.stringify(logs).includes('12345678'));
});

test('ledger summaries never return or read diagnostic documents',async()=>{
  const store=new MemoryStorage();await store.write('board/index.json',{runs:[],errors:[{day:'2026-09-07',code:'engine',count:4}]});
  const before=await store.read('board/index.json');const reads=[];const read=store.read.bind(store);store.read=async path=>{reads.push(path);return read(path);};
  await storageContext.run(store,async()=>{
    const response=await handler(new Request('https://example.test/api/stats'));
    assert.equal(response.status,200);const result=await response.json();
    assert.equal('errors' in result,false);assert.equal('errorSince' in result,false);
  });
  assert.ok(!reads.some(path=>path.startsWith('ledger/errors/')));
  assert.equal((await store.list('ledger/errors/')).length,0);
  assert.deepEqual(await store.read('board/index.json'),before);
});

test('every failed game entry produces a bounded private log event',async t=>{
 const logs=[];t.mock.method(console,'warn',entry=>logs.push(JSON.parse(entry)));
 for(let i=0;i<2;i++){
  const response=await handler(new Request('https://neohack.dev/api/errors',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:'network',entry:{kind:'resume',local:false,secret:'never logged'},message:'private save data'})}));
  assert.equal(response.status,204);
 }
 assert.deepEqual(logs,[0,1].map(()=>({event:'game_entry_failed',code:'network',kind:'resume',local:false})));
});
