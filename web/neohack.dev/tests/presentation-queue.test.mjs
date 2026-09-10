import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PresentationQueue} from '../src/presentation-queue.ts';
const frame=(revision,sessionId='one')=>({sessionId,revision});

test('completed actions queue independently, remain ordered and accelerate after thirty',async t=>{
 const shown=[],q=new PresentationQueue((f,ms,paint)=>shown.push({revision:f.revision,ms,paint}));t.after(()=>q.close());
 q.reset(frame(0));
 for(let i=1;i<=60;i++)await q.push(frame(i));
 assert.equal(q.current.revision,0);assert.equal(q.pending,60);assert.equal(q.duration,90);
 await new Promise(resolve=>setTimeout(resolve,210));
 assert.ok(shown.length>1&&shown.length<60);
 assert.ok(shown.slice(1).every(f=>f.ms<180));
 q.flush();assert.deepEqual(shown.map(f=>f.revision),Array.from({length:61},(_,i)=>i));
 assert.equal(q.pending,0);assert.equal(q.current.revision,60);
 assert.equal(shown.filter(f=>f.ms===0&&f.paint).length,2,'first frame and final catch-up frame paint; all journal entries survive');
});

test('full queue bounds memory and releases waiting producers on catch-up and teardown',async()=>{
 const q=new PresentationQueue(()=>{});q.reset(frame(0));
 for(let i=1;i<=120;i++)await q.push(frame(i));
 let completed=false;const blocked=q.push(frame(121)).then(()=>completed=true);
 await Promise.resolve();assert.equal(completed,false);assert.equal(q.pending,120);
 q.flush();await blocked;assert.equal(q.pending,1);q.close();
 const r=new PresentationQueue(()=>{});r.reset(frame(0));for(let i=1;i<=120;i++)await r.push(frame(i));
 const closed=r.push(frame(121));r.close();await closed;assert.equal(r.pending,0);
});

test('instant presentation never delays inputs, historical revisions and other runs do not leak',async()=>{
 const shown=[],q=new PresentationQueue(f=>shown.push([f.sessionId,f.revision]),()=>true);
 q.reset(frame(0));await q.push(frame(1));await q.push(frame(0));assert.equal(q.pending,0);
 await q.push(frame(0,'two'));assert.equal(q.current.sessionId,'two');
 assert.deepEqual(shown,[['one',0],['one',1],['two',0]]);q.close();
});
