import {test} from 'node:test';
import assert from 'node:assert/strict';
const perceivedFrame=({neighborhood,...frame})=>frame;
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {root,identity} from './native-fixture.mjs';
import {startMcpHttp,HTTP_PROTOCOL_VERSION} from './mcp-fixture.mjs';
import {tools} from '../dist/mcp/agent-data.js';

for(const mode of ['stdio','http'])test(`native ${mode} navigation interface owns guards, navigation and explicit decisions`,async t=>{
  const sessionsPath=await mkdtemp(`${tmpdir()}/neo33-agent-${mode}-`);
  const options={enginePath:`${root}/engine/playground/nethack`,dataPath:`${root}/engine/playground`,sessionsPath};
  let rpc,close;
  if(mode==='stdio'){
    const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
    const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
    const client=new Client({name:'agent-contract',version:'1'});
    await client.connect(new StdioClientTransport({command:`${root}/build/native/neonethack-mcp`,args:Object.values(options),stderr:'pipe'}));
    close=()=>client.close();
    rpc=(method,params={})=>method==='tools/list'?client.listTools():client.callTool(params);
  }else{
    const server=await startMcpHttp(options);close=()=>server.close();let id=0;
    rpc=async(method,params={})=>{
      const response=await fetch(server.url,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':HTTP_PROTOCOL_VERSION,'Mcp-Method':method,...(params.name?{'Mcp-Name':params.name}:{})},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':HTTP_PROTOCOL_VERSION,'io.modelcontextprotocol/clientCapabilities':{},'io.modelcontextprotocol/clientInfo':{name:'agent-test',version:'1'}}}})});
      const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body.result;
    };
  }
  t.after(async()=>{await close();await rm(sessionsPath,{recursive:true,force:true});});
  assert.deepEqual((await rpc('tools/list')).tools,tools);
  const call=async(name,args={})=>{
    const result=await rpc('tools/call',{name,arguments:args});
    assert.deepEqual(result.content,[]);return result.structuredContent;
  };
  assert.ok((await call('help')).tools.every(t=>!t.inputSchema));
  assert.equal((await call('help',{name:'go'})).tool.name,'go');
  const created=await call('session_create',{...identity,seed:7}),sid={sessionId:created.sessionId};
  assert.match(created.sessionId,/^[A-Za-z0-9_-]{16}$/);assert.equal(created.update,undefined);
  const [wait,queued]=await Promise.all([call('game_wait',sid),call('game_wait',sid)]);
  assert.ok(!wait.error);assert.equal(queued.error.code,'staleRevision');
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
