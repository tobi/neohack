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
 assert.equal(sent.length,1,'one directory registration despite sustained input and a slow connection');
 assert.ok(sent[0].url.endsWith('/adventures'),'the ledger waits until the vault has registered the run');
 release();await settle();await settle();
 assert.equal(sent.length,2);assert.equal(sent[1].url,'/api/runs');assert.equal(sent[1].body.vault,'vault');
 t.mock.timers.tick(5000);await settle();await settle();
 assert.equal(sent.length,4,'one follow-up publishes the latest state');
 assert.equal(sent.filter(x=>x.url.endsWith('/adventures'))[1].body[0].turn,40);
 assert.equal(sent.filter(x=>x.url==='/api/runs')[1].body.runs[0].turn,40);
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
 const entries=sent.find(x=>x.url.endsWith('/adventures')).body;
 assert.deepEqual(entries.map(({id,turn})=>({id,turn})),[{id:'first',turn:2},{id:'second',turn:1}]);
 assert.ok(!JSON.stringify(sent).includes('device-local'));
 assert.ok(!JSON.stringify(sent).includes('savedAt'));
});

test('registration shares latest directory metadata and does not require the ledger',async t=>{
 globalThis.window=new EventTarget();t.after(()=>delete globalThis.window);
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});
 const {queueCloud,registerCloudRun}=await import('../../../web/neohack.dev/src/cloud.ts?registration');
 const sent=[];let release;const gate=new Promise(r=>release=r);
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  sent.push({url,body:JSON.parse(options.body)});
  if(url==='/api/runs')return new Response('{}',{status:503});
  if(sent.filter(x=>x.url.endsWith('/adventures')).length===1)await gate;
  return new Response(null,{status:204});
 });
 const run=(turn,name)=>({id:'registration',name,role:'wizard',turn,ended:false});
 queueCloud([run(1,'Old')],'registration-vault');
 t.mock.timers.tick(5000);await settle();
 queueCloud([run(2,'New')],'registration-vault');
 const registration=registerCloudRun(run(2,'New'),'registration-vault',new AbortController().signal);
 // New metadata arrives while both old publication and registration are waiting.
 queueCloud([run(2,'Newest same-turn name')],'registration-vault');
 release();await registration;
 const directory=sent.filter(x=>x.url.endsWith('/adventures'));
 assert.deepEqual(directory.map(x=>[x.body[0].turn,x.body[0].name]),[[1,'Old'],[2,'Newest same-turn name']]);
 t.mock.timers.tick(10000);await settle();
 assert.equal(sent.filter(x=>x.url.endsWith('/adventures')).length,2,'queued old snapshot cannot overwrite registration');
});

test('cancelled registration queued behind another write does not send late metadata',async t=>{
 globalThis.window=new EventTarget();t.after(()=>delete globalThis.window);
 const {registerCloudRun}=await import('../../../web/neohack.dev/src/cloud.ts?cancel');
 let release;const gate=new Promise(r=>release=r),sent=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{sent.push(JSON.parse(options.body));await gate;return new Response(null,{status:204})});
 const run=id=>({id,name:id,role:'wizard',turn:1,ended:false});
 const first=registerCloudRun(run('first'),'cancel-vault',new AbortController().signal);await settle();
 const abort=new AbortController(),second=registerCloudRun(run('second'),'cancel-vault',abort.signal);
 abort.abort();release();await first;await assert.rejects(second);
 assert.equal(sent.length,1);assert.equal(sent[0][0].id,'first');
});
