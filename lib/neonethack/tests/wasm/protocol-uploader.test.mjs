import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ProtocolUploader} from '../../wasm/protocol-uploader.mjs';

function fixture(t){
 const checkpoint={index:1,sha256:'a'.repeat(64),bytes:new Uint8Array([1,2])};
 let ack={count:1,manifest:'original'};
 const store={upload:async()=>structuredClone(ack),checkpoint:async()=>checkpoint,acknowledge:async(_id,value)=>{ack=structuredClone(value);}};
 const uploader=new ProtocolUploader({store,headers:new Map([['run',{count:1,checkpoint}]]),url:'https://fixture.invalid/',token:'fixture'});
 uploader.dirty.add('run');t.after(()=>uploader.close());
 return {uploader,checkpoint,get ack(){return ack;}};
}

test('checkpoint publication checks acknowledgements and retains the old cursor on failure',async t=>{
 for(const reply of [{status:503},{hash:'wrong',index:1},{hash:'a'.repeat(64),index:2}]){
  const f=fixture(t),before=structuredClone(f.ack);
  t.mock.method(globalThis,'fetch',async()=>reply.status?new Response('',{status:reply.status}):Response.json(reply));
  await assert.rejects(f.uploader.pump(),/Checkpoint (upload pending|acknowledgement differs)/);
  assert.deepEqual(f.ack,before);
  t.mock.restoreAll();
 }
});

test('checkpoint publication commits only a matching response and does not upload it twice',async t=>{
 const f=fixture(t);let calls=0;
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  calls++;assert.equal(url.pathname,'/run/checkpoint');assert.deepEqual(options.body,f.checkpoint.bytes);
  assert.equal(options.headers['x-checkpoint-index'],'1');
  return Response.json({hash:f.checkpoint.sha256,index:1,manifest:'published'});
 });
 await f.uploader.pump();assert.equal(f.ack.checkpoint,f.checkpoint.sha256);assert.equal(f.ack.manifest,'published');
 f.uploader.dirty.add('run');await f.uploader.pump();assert.equal(calls,1);
});

test('closing during a checkpoint response cannot advance local upload metadata',async t=>{
 const f=fixture(t),before=structuredClone(f.ack);
 let release,started;
 const arrived=new Promise(resolve=>{started=resolve;});
 t.mock.method(globalThis,'fetch',()=>{started();return new Promise(resolve=>{release=resolve;});});
 const pumping=f.uploader.pump();await arrived;f.uploader.close();
 release(Response.json({hash:f.checkpoint.sha256,index:1}));
 await pumping;assert.deepEqual(f.ack,before);
 f.uploader.queue('other');await f.uploader.flush();assert.equal(f.uploader.dirty.has('other'),false);
});

test('active engine work postpones a flush without fetching or acknowledging',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const f=fixture(t),before=structuredClone(f.ack);
 f.uploader.active=()=>true;
 t.mock.method(globalThis,'fetch',()=>assert.fail('network work must wait'));
 await f.uploader.flush();t.mock.timers.tick(100);await Promise.resolve();
 assert.deepEqual(f.ack,before);
});
