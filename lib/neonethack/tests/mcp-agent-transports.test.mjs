import {test} from 'node:test';
import assert from 'node:assert/strict';
const perceivedFrame=({neighborhood,...frame})=>frame;
import {mkdtemp,rm,readFile,writeFile,readdir,readlink} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {request} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {tmpdir} from 'node:os';
import {root,identity} from './native-fixture.mjs';
import {startMcpHttp,HTTP_PROTOCOL_VERSION} from './mcp-fixture.mjs';
import {tools} from '../dist/mcp/agent-data.js';

for(const mode of ['stdio','http'])test(`native ${mode} navigation interface owns guards, navigation and explicit decisions`,async t=>{
  const sessionsPath=await mkdtemp(`${tmpdir()}/neo33-agent-${mode}-`);
  const options={enginePath:`${root}/engine/playground/nethack`,dataPath:`${root}/engine/playground`,sessionsPath};
  let rpc,close,overlappingWaits;
  if(mode==='stdio'){
    const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
    const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
    const client=new Client({name:'agent-contract',version:'1'});
    await client.connect(new StdioClientTransport({command:`${root}/build/native/neonethack-mcp`,args:Object.values(options),stderr:'pipe'}));
    close=()=>client.close();
    rpc=(method,params={})=>method==='tools/list'?client.listTools():client.callTool(params);
  }else{
    const armed=sessionsPath+'/stop-reply',admissions=sessionsPath+'/admissions',interposer=sessionsPath+'/stop.so';
    await writeFile(admissions,'');
    execFileSync(process.env.CC??'cc',['-shared','-fPIC',root+'/tests/mcp-reply-stop.c','-ldl','-o',interposer]);
    const server=await startMcpHttp({...options,env:{...process.env,LD_PRELOAD:interposer,NNH_TEST_STOP_REPLY:armed,NNH_TEST_ADMISSIONS:admissions}});
    close=()=>server.close();let id=0;
    rpc=(method,params={},held)=>new Promise((resolve,reject)=>{
      const body=JSON.stringify({jsonrpc:'2.0',id:++id,method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':HTTP_PROTOCOL_VERSION,'io.modelcontextprotocol/clientCapabilities':{},'io.modelcontextprotocol/clientInfo':{name:'agent-test',version:'1'}}}});
      const req=request(server.url,{method:'POST',agent:false,headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','Content-Length':Buffer.byteLength(body),'MCP-Protocol-Version':HTTP_PROTOCOL_VERSION,'Mcp-Method':method,...(params.name?{'Mcp-Name':params.name}:{})}},res=>{
        let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>{
          try{const response=JSON.parse(text);assert.equal(res.statusCode,200,text);resolve(response.result);}catch(error){reject(error);}
        });
      });
      req.on('error',reject);req.setTimeout(10000,()=>req.destroy(Error('HTTP test request timed out; no retry')));
      if(held){held.release=()=>{held.release=undefined;req.end(body);};req.flushHeaders();}else req.end(body);
    });
    overlappingWaits=async(call,sid)=>{
      let worker;
      for(const pid of(await readFile('/proc/'+server.process.pid+'/task/'+server.process.pid+'/children','utf8')).trim().split(/\s+/))
        for(const fd of await readdir('/proc/'+pid+'/fd'))
          if((await readlink('/proc/'+pid+'/fd/'+fd).catch(()=>'' )).endsWith('/'+sid.sessionId+'/.lease'))worker=Number(pid);
      assert.ok(worker,'locate this server-owned game worker');
      const count=async()=>(await readFile(admissions,'utf8')).split('\n').filter(pid=>pid===String(server.process.pid)).length;
      const until=async(fn,label)=>{for(let i=0;i<300;i++){if(await fn())return;await delay(10);}assert.fail(label);};
      const journalPath=sessionsPath+'/'+sid.sessionId+'/input.log.jsonl';
      const journalBefore=await readFile(journalPath,'utf8');
      const baseline=await count(),held={};let first,second;
      try{
        await writeFile(armed,'hold the committed response before supervisor revision advances');
        // A starts first on its own connection, but B must be admitted first.
        first=call('game_wait',sid,held);first.catch(()=>{});
        second=call('game_wait',sid);second.catch(()=>{});
        await until(async()=>/^State:\s+T/m.test(await readFile('/proc/'+worker+'/status','utf8')),'B committed response is held');
        held.release();
        // mcp_route logs admission before its synchronous capture/enqueue; no
        // worker response can advance the revision during that callback.
        await until(async()=>await count()===baseline+2,'both requests admitted before releasing the response');
        process.kill(worker,'SIGCONT');
        const results=await Promise.all([first,second]);
        const journalAfter=await readFile(journalPath,'utf8');
        const addedInputs=journalAfter.trim().split('\n').length-journalBefore.trim().split('\n').length;
        const diagnostic=JSON.stringify({admissions:await count()-baseline,addedInputs,results});
        assert.equal(addedInputs,1,diagnostic);
        const winners=results.filter(result=>!result.error),stale=results.filter(result=>result.error?.code==='staleRevision');
        assert.equal(winners.length,1,diagnostic);assert.equal(stale.length,1,diagnostic);
        assert.equal(stale[0].operationId,undefined,diagnostic);
        assert.equal(results[0].error?.code,'staleRevision',diagnostic);
        return winners[0];
      }finally{
        // A timeout before commit must not leave a future response armed to stop.
        await rm(armed,{force:true});
        held.release?.();try{process.kill(worker,'SIGCONT');}catch{}
        await Promise.allSettled([first,second]);
      }
    };
  }
  t.after(async()=>{await close();await rm(sessionsPath,{recursive:true,force:true});});
  assert.deepEqual((await rpc('tools/list')).tools,tools);
  const call=async(name,args={},held)=>{
    const result=await rpc('tools/call',{name,arguments:args},held);
    assert.deepEqual(result.content,[]);return result.structuredContent;
  };
  assert.ok((await call('help')).tools.every(t=>!t.inputSchema));
  assert.equal((await call('help',{name:'go'})).tool.name,'go');
  const created=await call('session_create',{...identity,seed:7}),sid={sessionId:created.sessionId};
  assert.match(created.sessionId,/^[A-Za-z0-9_-]{16}$/);assert.equal(created.update,undefined);
  let wait;
  if(overlappingWaits)wait=await overlappingWaits(call,sid);
  else{
    const results=await Promise.all([call('game_wait',sid),call('game_wait',sid)]);
    [wait]=results;assert.ok(!wait.error,JSON.stringify(results));assert.equal(results[1].error?.code,'staleRevision',JSON.stringify(results));
  }
  assert.equal(wait.observation.turn-created.observation.turn,wait.outcome.turnsElapsed);
  assert.equal(wait.outcome.turnsElapsed,1,JSON.stringify(wait));
  const ask=await call('game_eat',sid);assert.equal(ask.decision.kind,'item');
  const stopped=await call('explore',sid);assert.equal(stopped.navigation.reason,'decision');assert.equal(stopped.navigation.actionsTaken,0);
  assert.equal(stopped.operationId,undefined,'a zero-input leg cannot borrow the preceding receipt');
  assert.deepEqual(stopped.events,[]);
  assert.deepEqual(stopped.outcome,{action:'navigation',status:'completed',turnsElapsed:0,positionChanged:false,effects:[]});
  assert.equal((await call('decision_cancel',{...sid,decisionId:ask.decision.id})).decision,null);
  const receipt=await call('receipt',{...sid,operationId:wait.operationId});assert.deepEqual(perceivedFrame(receipt.observation),perceivedFrame(wait.observation));assert.equal(receipt.historical,true);
  const leg=await call('explore',{...sid,maxActions:3});assert.ok(!leg.error,JSON.stringify(leg.error));assert.ok(leg.navigation.actionsTaken<=3);assert.match(leg.summary,/Navigation:/);
  assert.equal((await call('session_close',sid)).error,undefined);
  const resumed=await call('session_resume',sid);assert.deepEqual(perceivedFrame(resumed.observation),perceivedFrame(leg.observation));
  await call('session_close',sid);

  // Recorded seed-42 regression: explore used to walk seven turns toward the
  // second room's closed door, then fail its malformed door substep and hide
  // the committed walking behind "no operation was sent".
  const room=await call('session_create',{role:'valkyrie',seed:42}),run={sessionId:room.sessionId};
  assert.deepEqual(room.observation.you,{x:65,y:4});
  const approach=await call('go',{...run,to:{x:59,y:6}});
  assert.equal(approach.observation.turn,7);
  const alreadyThere=await call('go',{...run,to:approach.observation.you});
  assert.equal(alreadyThere.operationId,undefined);
  assert.equal(alreadyThere.outcome.turnsElapsed,0);
  assert.deepEqual(alreadyThere.events,[]);
  await call('game_open',{...run,target:{direction:'west'}});
  let frame;
  for(let i=0;i<16;i++){
    frame=await call('explore',{...run,maxActions:20});
    assert.ok(!frame.error,JSON.stringify(frame.error));
  }
  assert.equal(frame.observation.turn,25);
  const opened=await call('explore',{...run,maxActions:20,maxFrontiers:4});
  assert.ok(!opened.error,JSON.stringify(opened.error));
  assert.equal(opened.outcome.action,'open');
  assert.equal(opened.navigation.actionsTaken,8,'seven walking steps and one door attempt');
  assert.equal(opened.navigation.turnsElapsed,8);
  assert.equal(opened.observation.turn,33);
  assert.deepEqual(opened.observation.you,{x:41,y:7});
  assert.equal(opened.observation.world.find(c=>c.x===40&&c.y===7)?.terrain.type,'openDoor');
  assert.equal((await call('session_observe',run)).observation.turn,33);
  // More frontiers are explicitly requested; the door attempt above still
  // ended its leg. Now four corridor frontiers share one global action bound.
  const several=await call('explore',{...run,maxActions:20,maxFrontiers:4});
  assert.equal(several.navigation.actionsTaken,4);
  assert.equal(several.navigation.turnsElapsed,4);
  assert.equal(several.navigation.reason,'arrived');
  assert.deepEqual(several.observation.you,{x:37,y:7});
  const bounded=await call('explore',{...run,maxActions:2,maxFrontiers:4});
  assert.equal(bounded.navigation.actionsTaken,2);
  assert.equal(bounded.navigation.reason,'stepLimit');
  await call('session_close',run);
});
