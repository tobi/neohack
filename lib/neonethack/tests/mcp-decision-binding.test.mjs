import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {root} from './native-fixture.mjs';
import {startMcpHttp,HTTP_PROTOCOL_VERSION} from './mcp-fixture.mjs';
import {NativeTransport} from '../dist/typescript/native.js';
import {AgentClient} from '../dist/mcp/agent.js';

for(const mode of ['stdio','http','typescript'])test(`${mode}: decision identities survive resume and reject stale confirmations, cancellations and named transfers`,async t=>{
  const sessionsPath=await mkdtemp(`${tmpdir()}/nnh-decision-binding-`);
  const options={enginePath:`${root}/engine/playground/nethack`,dataPath:`${root}/engine/playground`,sessionsPath};
  let call,close,serial=0,restart=async()=>{};
  if(mode==='http'){
    let server=await startMcpHttp(options);close=()=>server.close();
    restart=async()=>{await server.close();server=await startMcpHttp(options);};
    // Each call uses a fresh HTTP connection. Client metadata conveys no authority.
    call=async(who,name,args)=>{
      const response=await fetch(server.url,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':HTTP_PROTOCOL_VERSION,'Mcp-Method':'tools/call','Mcp-Name':name,Connection:'close'},body:JSON.stringify({jsonrpc:'2.0',id:++serial,method:'tools/call',params:{name,arguments:args,_meta:{'io.modelcontextprotocol/protocolVersion':HTTP_PROTOCOL_VERSION,'io.modelcontextprotocol/clientCapabilities':{},'io.modelcontextprotocol/clientInfo':{name:who,version:'1'}}}})});
      const body=await response.json();assert.equal(response.status,200);assert.ok(!body.error,JSON.stringify(body.error));return body.result.structuredContent;
    };
  }else if(mode==='stdio'){
    const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
    const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
    const client=new Client({name:'decision-binding',version:'1'});
    await client.connect(new StdioClientTransport({command:`${root}/dist/mcp/cli.js`,args:['--sessions',sessionsPath],stderr:'pipe'}));
    close=()=>client.close();call=async(_who,name,args)=>(await client.callTool({name,arguments:args})).structuredContent;
  }else{
    const transport=new NativeTransport({executable:`${root}/build/native/neonethack`,...options});
    const agent=new AgentClient(transport);close=()=>transport.close();call=(_who,name,args)=>agent.call(name,args);
  }
  t.after(async()=>{await close();await rm(sessionsPath,{recursive:true,force:true});});
  const A=(name,args)=>call('observer-A',name,args),B=(name,args)=>call('observer-B',name,args);
  const created=await A("create",{role:'valkyrie',seed:9}),sid={sessionId:created.sessionId};
  const prayer=await A("pray",sid);assert.equal(prayer.decision.kind,'confirmation');
  await B("cancel",{...sid,decisionId:prayer.decision.id});
  const quit=await B("quit",sid);assert.equal(quit.decision.kind,'confirmation');assert.notEqual(quit.decision.id,prayer.decision.id);
  await B("suspend",sid);
  await restart();
  const resumed=await B("resume",sid);assert.deepEqual(resumed.decision,quit.decision);
  const stale=await A("answer",{...sid,decisionId:prayer.decision.id,value: true});
  assert.equal(stale.error?.code,'staleDecision');assert.equal(stale.operationId,undefined);
  const staleCancel=await A("cancel",{...sid,decisionId:prayer.decision.id});assert.equal(staleCancel.error?.code,'staleDecision');
  const current=await B("syncState",sid);assert.equal(current.ended,false);assert.equal(current.observation.turn,quit.observation.turn);assert.deepEqual(current.decision,quit.decision);
  const declined=await B("answer",{...sid,decisionId:quit.decision.id,value: false});assert.equal(declined.decision,null);
  const receipt=await A('receipt',{...sid,operationId:declined.operationId});assert.equal(receipt.operationId,declined.operationId);assert.equal(receipt.receipt.observation.turn,declined.observation.turn);
  assert.equal((await B("syncState",sid)).observation.turn,declined.observation.turn);
  await A("suspend",sid);
  await B("resume",sid);
  const later=await B("pray",sid);assert.notEqual(later.decision.id,prayer.decision.id);assert.notEqual(later.decision.id,quit.decision.id);
  assert.equal((await A("cancel",{...sid,decisionId:prayer.decision.id})).error?.code,'staleDecision');
  await B("cancel",{...sid,decisionId:later.decision.id});
  await A("suspend",sid);

  const archaeologist=await A("create",{role:'archeologist',seed:13}),bagRun={sessionId:archaeologist.sessionId};
  const sack=archaeologist.observation.inventory.find(i=>i.known.identity==='sack');assert.ok(sack);
  const open=()=>B("apply",{...bagRun,itemId: sack.id});
  const putMenu=await open();const oldPut=putMenu.decision.options.find(o=>o.transfer==='put'&&o.label.includes('food rations'));assert.ok(oldPut);
  // Overlapping lifecycle callbacks must not cancel a replacement context.
  const cancellations=await Promise.all([A("cancel",{...bagRun,decisionId:putMenu.decision.id}),B("cancel",{...bagRun,decisionId:putMenu.decision.id})]);
  assert.equal(cancellations.filter(r=>!r.error).length,1);assert.equal(cancellations.filter(r=>r.error?.code==='staleDecision'||r.error?.code==='staleRevision').length,1);
  const freshPut=await open();const choice=freshPut.decision.options.find(o=>o.transfer==='put'&&o.label.includes('food rations'));
  await B("answer",{...bagRun,decisionId:freshPut.decision.id,value: [choice.name]});
  const takeMenu=await open();const take=takeMenu.decision.options.find(o=>o.transfer==='take');assert.equal(take.name,oldPut.name);
  await B("suspend",bagRun);await restart();assert.deepEqual((await B("resume",bagRun)).decision,takeMenu.decision);
  const oldAnswer=await A("answer",{...bagRun,decisionId:putMenu.decision.id,value: [oldPut.name]});assert.equal(oldAnswer.error?.code,'staleDecision');
  const still=await B("syncState",bagRun);assert.equal(still.observation.turn,takeMenu.observation.turn);assert.deepEqual(still.decision,takeMenu.decision);
  const taken=await B("answer",{...bagRun,decisionId:takeMenu.decision.id,value: [take.name]});assert.equal(taken.observation.turn,takeMenu.observation.turn+1);assert.ok(taken.observation.inventory.some(i=>i.known.identity==='food ration'&&i.quantity===4));
  assert.equal((await A("syncState",bagRun)).revision,taken.revision);
  await A("suspend",bagRun);
});
