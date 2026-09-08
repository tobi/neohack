import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir,readlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {root,identity} from './native-fixture.mjs';
import {startMcpHttp,HTTP_PROTOCOL_VERSION} from './mcp-fixture.mjs';

for(const fault of ['worker-death','disconnect'])for(const action of ['game_wait','explore','decision_answer'])test(`supervisor recovers ${action} after committed input and ${fault}`, {timeout:30000}, async t=>{
  const directory=await mkdtemp(`${tmpdir()}/neo33-recovery-`), armed=`${directory}/stop-reply`,interposer=`${directory}/stop.so`;
  execFileSync(process.env.CC??'cc',['-shared','-fPIC',`${root}/tests/mcp-reply-stop.c`,'-ldl','-o',interposer]);
  const server=await startMcpHttp({enginePath:`${root}/engine/playground/nethack`,dataPath:`${root}/engine/playground`,sessionsPath:`${directory}/sessions`,env:{...process.env,LD_PRELOAD:interposer,NNH_TEST_STOP_REPLY:armed}});
  let worker;
  t.after(async()=>{if(worker)try{process.kill(worker,'SIGCONT');}catch{}await server.close();await rm(directory,{recursive:true,force:true});});
  let serial=0;
  const call=async(name,args={},signal)=>{
    const response=await fetch(server.url,{method:'POST',signal,headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':HTTP_PROTOCOL_VERSION,'Mcp-Method':'tools/call','Mcp-Name':name},body:JSON.stringify({jsonrpc:'2.0',id:++serial,method:'tools/call',params:{name,arguments:args,_meta:{'io.modelcontextprotocol/protocolVersion':HTTP_PROTOCOL_VERSION,'io.modelcontextprotocol/clientCapabilities':{},'io.modelcontextprotocol/clientInfo':{name:'recovery-test',version:'1'}}}})});
    const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body.result.structuredContent;
  };
  const created=await call('session_create',identity),sid={sessionId:created.sessionId};
  const question=action==='decision_answer'?await call('game_pray',sid):null;
  const children=(await readFile(`/proc/${server.process.pid}/task/${server.process.pid}/children`,'utf8')).trim().split(/\s+/);
  for(const pid of children)for(const fd of await readdir(`/proc/${pid}/fd`)){
    const path=await readlink(`/proc/${pid}/fd/${fd}`).catch(()=>'');
    if(path.endsWith(`/${sid.sessionId}/.lease`))worker=Number(pid);
  }
  assert.ok(worker,'actual run worker owns the engine lease');
  await writeFile(armed,'stop exactly one committed reply');
  const cancellation=new AbortController();
  const pending=call(action,action==='explore'?{...sid,maxActions:3}:question?{...sid,decisionId:question.decision.id,answer:{kind:'confirmation',confirm:false}}:sid,cancellation.signal).catch(error=>({transportError:error.name}));
  let stopped=false;
  for(let i=0;i<500;i++){
    const status=await readFile(`/proc/${worker}/status`,'utf8');
    if(/^State:\s+T/m.test(status)){stopped=true;break;}await delay(10);
  }
  assert.ok(stopped,'worker reached the post-commit reply boundary');
  let lost,resumed;
  if(fault==='worker-death'){
    process.kill(worker,'SIGKILL');worker=undefined;
    lost=await pending;assert.equal(lost.error.code,'uncertainExecution');assert.ok(lost.operationId);
    assert.equal((await call('game_wait',sid)).error.code,'uncertainExecution','no new input while recovery is unresolved');
    // The killed worker's engine may still be exiting and holding its lease.
    // Re-attempt only read/recovery admission, never a gameplay input.
    const retirementDeadline=Date.now()+3000;
    do {
      resumed=await call('session_resume',sid);
      if(resumed.error?.code!=='sessionBusy')break;
      await delay(10);
    } while(Date.now()<retirementDeadline);
    assert.equal((await call('game_wait',sid)).error.code,'uncertainExecution','resume alone does not authorize new input');
  }else{
    cancellation.abort();assert.equal((await pending).transportError,'AbortError');
    process.kill(worker,'SIGCONT');
    resumed=await call('session_observe',sid);
  }
  assert.ok(!resumed.error,JSON.stringify(resumed.error));
  const elapsed=resumed.observation.turn-created.observation.turn;
  assert.ok(elapsed>=(question?0:1) && elapsed<=(action==='explore'?3:question?0:1));
  if(question)assert.equal(resumed.decision,null,'committed decline stays resolved during exact recovery');
  const [retry,read]=await Promise.all([call('retry',sid),call('session_observe',sid)]);
  assert.ok(!retry.error,JSON.stringify(retry.error));assert.ok(!read.error);
  if(lost)assert.equal(retry.operationId,lost.operationId);
  else assert.equal(retry.historical,true);assert.equal(retry.observation.turn,resumed.observation.turn);
  assert.deepEqual(retry.observation,read.observation,'retry restores the complete receipt, including the neighborhood');
  const {neighborhood,...recoveredScene}=retry.observation;
  const {neighborhood:resumeNeighborhood,...resumedScene}=resumed.observation;
  assert.deepEqual(recoveredScene,resumedScene,'compact resume and full retry describe the same perceived scene');
  const next=await call('game_wait',sid);assert.ok(!next.error);assert.equal(next.observation.turn,retry.observation.turn+1);
});
