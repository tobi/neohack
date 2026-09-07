import {test} from 'node:test';import assert from 'node:assert/strict';
import {ReplicaUploader} from '../wasm/replica-uploader.mjs';
import {setImmediate as settle} from 'node:timers/promises';
function fixture(send){let outbox=null,cursor=null;const files=[['a',{blocks:['hash']}]],status=[];const store={snapshot:async()=>({files,blocks:[['hash','bytes']]}),replicaOutbox:async(...args)=>args.length?(outbox=structuredClone(args[0])):structuredClone(outbox),replicaCursor:async(revision)=>{cursor=revision;}};const uploader=new ReplicaUploader({store,url:'http://fixture',fetch:send,idle:0,backoff:60000,status:(...s)=>status.push(s)});return{uploader,status,get outbox(){return outbox;},get cursor(){return cursor;}};}
test('temporary failures preserve an immutable outbox and recover without new input',async()=>{
 const bodies=[];let success=false;const f=fixture(async(_,r)=>{bodies.push(r.body);if(!success)throw Error('signal timed out');return Response.json({revision:JSON.parse(r.body).commit});});
 f.uploader.pending=true;await f.uploader.upload(true);clearTimeout(f.uploader.timer);
 assert.equal(f.uploader.failed,false);assert.equal(f.status.at(-1)[0],'retrying');const original=f.outbox;
 success=true;await f.uploader.upload(true);clearTimeout(f.uploader.timer);
 assert.equal(bodies[0],bodies[1]);assert.equal(f.cursor,original.commit);assert.equal(f.outbox,null);
 await f.uploader.close();
});
test('a restarted uploader retries the saved uncertain commit, not a newer local snapshot',async()=>{
 let first;const f=fixture(async(_,r)=>{first=r.body;throw Error('lost response');});f.uploader.pending=true;await f.uploader.upload(true);clearTimeout(f.uploader.timer);
 const pending=f.outbox;let sent;f.uploader.send=async(_,r)=>{sent=r.body;return Response.json({revision:pending.commit});};
 await f.uploader.upload(true);clearTimeout(f.uploader.timer);assert.equal(sent,first);await f.uploader.close();
});
test('conflicts and invalid acknowledgements stop replication and retain local outbox',async()=>{
 for(const response of [new Response('',{status:409}),Response.json({revision:'wrong'})]){
 const f=fixture(async()=>response);f.uploader.pending=true;await f.uploader.upload(true);assert.equal(f.uploader.failed,true);assert.ok(f.outbox);assert.equal(f.cursor,null);assert.equal(f.status.at(-1)[0],'error');await f.uploader.close();}
});
test('continuous local play uploads at thirty seconds; idle play uploads after five',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:0});
 const sent=[];const f=fixture(async(_,r)=>{sent.push(Date.now());return Response.json({revision:JSON.parse(r.body).commit});});
 f.uploader.idle=5000;f.uploader.interval=30000;
 f.uploader.queue();
 for(let i=1;i<30;i++){t.mock.timers.tick(1000);f.uploader.queue();await settle();}
 assert.deepEqual(sent,[],'activity delays the idle upload');
 t.mock.timers.tick(1000);await settle();assert.deepEqual(sent,[30000],'activity cannot postpone sync forever');
 await f.uploader.close();
 const quiet=[];const g=fixture(async(_,r)=>{quiet.push(Date.now());return Response.json({revision:JSON.parse(r.body).commit});});g.uploader.idle=5000;
 g.uploader.queue();t.mock.timers.tick(4999);await settle();assert.deepEqual(quiet,[]);
 t.mock.timers.tick(1);await settle();assert.deepEqual(quiet,[35000]);await g.uploader.close();
});
