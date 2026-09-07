import {test} from 'node:test';
import assert from 'node:assert/strict';
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
  assert.equal((await call('decision_cancel',sid)).decision,null);
  const receipt=await call('receipt',{...sid,operationId:wait.operationId});assert.deepEqual(receipt.observation,wait.observation);assert.equal(receipt.historical,true);
  const leg=await call('explore',{...sid,maxActions:3});assert.ok(!leg.error,JSON.stringify(leg.error));assert.ok(leg.navigation.actionsTaken<=3);assert.match(leg.summary,/Navigation:/);
  assert.equal((await call('session_close',sid)).error,undefined);
  const resumed=await call('session_resume',sid);assert.deepEqual(resumed.observation,leg.observation);
});
