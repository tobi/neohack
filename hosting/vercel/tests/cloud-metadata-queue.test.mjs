import{test}from'node:test';import assert from'node:assert/strict';import{setImmediate as settle}from'node:timers/promises';
test('slow metadata upload coalesces continuing play instead of queuing stale snapshots',async t=>{
 globalThis.window=new EventTarget();t.after(()=>delete globalThis.window);
 t.mock.timers.enable({apis:['Date','setTimeout'],now:0});
 let release;const gate=new Promise(r=>release=r),sent=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{sent.push({url,body:JSON.parse(options.body)});await gate;return new Response('{}',{status:200});});
 const {queueCloud}=await import('../../../web/neohack.dev/src/cloud.ts');
 const run=turn=>[{id:'queue-probe',name:'Probe',role:'wizard',turn,ended:false}];
 queueCloud(run(0),'vault');
 for(let turn=1;turn<=40;turn++){t.mock.timers.tick(1000);queueCloud(run(turn),'vault');await settle();}
 assert.equal(sent.length,2,'one pair of requests despite sustained input and a slow connection');
 release();await settle();t.mock.timers.tick(5000);await settle();
 assert.equal(sent.length,4,'one follow-up publishes the latest state');
 assert.equal(sent[2].body[0].turn,40);assert.equal(sent[3].body.runs[0].turn,40);
});

test('switching runs before sync preserves both updates and keeps local store names off the server',async t=>{
 globalThis.window=new EventTarget();t.after(()=>delete globalThis.window);
 t.mock.timers.enable({apis:['Date','setTimeout'],now:0});
 const sent=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{sent.push({url,body:JSON.parse(options.body)});return new Response('{}',{status:200});});
 const {queueCloud}=await import('../../../web/neohack.dev/src/cloud.ts');
 const run=(id,turn)=>({id,name:id,role:'wizard',turn,ended:false,localStore:'device-local',savedAt:123});
 queueCloud([run('first',1)],'switch-vault');
 queueCloud([run('second',1)],'switch-vault');
 queueCloud([run('first',2)],'switch-vault');
 t.mock.timers.tick(5000);await settle();
 assert.equal(sent.length,2);
 const entries=sent[0].body;
 assert.deepEqual(entries.map(({id,turn})=>({id,turn})),[{id:'first',turn:2},{id:'second',turn:1}]);
 assert.ok(!JSON.stringify(sent).includes('device-local'));
 assert.ok(!JSON.stringify(sent).includes('savedAt'));
});
