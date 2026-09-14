import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fixture,identity,root} from './native-fixture.mjs';
import {mcpExecutable,startMcpHttp,HTTP_PROTOCOL_VERSION} from './mcp-fixture.mjs';
import {present} from '../dist/mcp/agent.js';
import {TestAgentClient as AgentClient,withSessionViews} from './mcp-view-fixture.mjs';
import {registerWebMcp} from '../dist/typescript/webmcp.js';

test('shared terminal presentation preserves full and compact facts',async t=>{
  const {api}=await fixture(t),game=await api.create(identity);
  const terminal={...game.state,ended:true,decision:null,requestId:'fatal-operation',events:[],
    end:{kind:'death',cause:'killed by a frost giant',turn:game.observation.turn},
    outcome:{action:'rest',status:'completed',turnsElapsed:0,positionChanged:false,effects:[]}};
  // Public presentation fixtures model the audited zero-clock action and leg;
  // they do not claim to reproduce the archived game or alter an engine save.
  const frames=[
    terminal,
    {...terminal,outcome:{...terminal.outcome,action:'move',status:'blocked',reason:'noProgress'},
      navigation:{reason:'ended',actionsTaken:1,turnsElapsed:0}},
    {...terminal,requestId:null,outcome:{...terminal.outcome,action:'get_state'}},
    {...terminal,end:{kind:'disconnected',turn:game.observation.turn},requestId:null,
      outcome:{...terminal.outcome,action:'end_session'}},
    {...terminal,end:{kind:'ascended',turn:game.observation.turn}},
    {...terminal,end:null},
    {...terminal,error:{code:'engineError',message:'Engine stopped.'}},
    {version:1,error:{code:'invalidParams',message:'No operation was sent.'}},
  ];
  for(const full of [false,true]){
    for(const frame of frames){
      const before=structuredClone(frame),{navigation,...snapshot}=frame;
      const result=present(snapshot,{full,...(navigation?{navigation}:{})});
      assert.deepEqual(frame,before,'presentation leaves its source untouched');
      assert.equal(result.version,2);
      if(frame.ended){
        assert.deepEqual(result.scene.end,frame.end);
        assert.equal(result.control.gate,frame.end?.kind==='disconnected'?'ownershipLost':'ended');
        assert.equal(result.outcome.turnsElapsed,frame.outcome.turnsElapsed);
        assert.equal(result.outcome.operationId,frame.requestId??undefined);
        if(frame.end?.cause){assert.ok(result.summary.startsWith('Run ended'));assert.ok(result.summary.includes(frame.end.cause));}
        assert.equal(result.scene.world!==undefined,full);
      }else {
        assert.equal(result.control.gate,'unavailable');assert.equal(result.scene,null);
        assert.equal(result.error.code,'invalidParams');
      }
    }
  }
});

async function client(t,mode){
  if(mode==='typescript'||mode==='webmcp'){
    const {transport}=await fixture(t);
    if(mode==='typescript'){
      const agent=new AgentClient(transport);
      return (name,args)=>agent.call(name,args);
    }
    const registered=new Map();
    const registration=await registerWebMcp(transport,{
      registerTool(tool){registered.set(tool.name,tool);},
      unregisterTool(name){registered.delete(name);},
    });
    t.after(()=>registration.dispose());
    return async(name,args)=>{
      const result=await registered.get(name).execute(args);
      assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent);
      return result.structuredContent;
    };
  }
  const sessionsPath=await mkdtemp(`${tmpdir()}/neonethack-terminal-${mode}-`);
  const options={enginePath:`${root}/engine/playground/nethack`,dataPath:`${root}/engine/playground`,sessionsPath};
  let call,close;
  if(mode==='stdio'){
    const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
    const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
    const sdk=new Client({name:'terminal-summary-test',version:'1'});
    await sdk.connect(new StdioClientTransport({command:mcpExecutable,args:['--sessions',sessionsPath],stderr:'pipe'}));
    call=params=>sdk.callTool(params);close=()=>sdk.close();
  }else{
    const server=await startMcpHttp(options);close=()=>server.close();let id=0;
    call=async params=>{
      const response=await fetch(server.url,{method:'POST',headers:{
        'Content-Type':'application/json',Accept:'application/json, text/event-stream',
        'MCP-Protocol-Version':HTTP_PROTOCOL_VERSION,'Mcp-Method':'tools/call','Mcp-Name':params.name,
      },body:JSON.stringify({jsonrpc:'2.0',id:++id,method:'tools/call',params:{...params,_meta:{
        'io.modelcontextprotocol/protocolVersion':HTTP_PROTOCOL_VERSION,
        'io.modelcontextprotocol/clientCapabilities':{},
        'io.modelcontextprotocol/clientInfo':{name:'terminal-summary-test',version:'1'},
      }}})});
      assert.equal(response.status,200);
      return (await response.json()).result;
    };
  }
  t.after(async()=>{await close();await rm(sessionsPath,{recursive:true,force:true});});
  return async(name,args)=>{
    const result=await call({name,arguments:args});
    assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent);
    return result.structuredContent;
  };
}

for(const mode of ['stdio','http','typescript','webmcp'])test(`${mode}: real terminal input, postmortem navigation/observe and disconnected close summaries`,{timeout:30000},async t=>{
  const call=withSessionViews(await client(t,mode));
  const start=await call("session", {action: "create", seed:4386,name:'Lifesaving',role:'tourist',race:'human',gender:'female',align:'neutral'});
  const sid={sessionId:start.basis.sessionId};assert.ok(sid.sessionId,JSON.stringify(start));
  const closed=await call("session", {action: "suspend", ...(sid)});
  assert.equal(closed.control.gate,closed.scene.end?.kind==='disconnected'?'ownershipLost':'ended');assert.equal(closed.scene.end.kind,'disconnected');
  assert.equal(closed.control.gate,'ownershipLost');
  assert.equal(closed.outcome.turnsElapsed,0);
  const resumed=await call("session", {action: "resume", ...(sid)});
  assert.equal(resumed.control.gate,'ready');assert.equal(resumed.scene.end,null);
  const moved=await call("travel", {mode: "to", ...sid,to:{x:start.scene.self.position.x-1,y:start.scene.self.position.y},maxActions:1});
  const amulet=moved.scene.here.items.find(item=>item.category==='amulet');assert.ok(amulet);
  await call("inventory", {action: "pickup", ...sid,itemId: amulet.id});
  const waited=await call("interact", {action: "rest", ...(sid)});
  const food=waited.scene.inventory.find(item=>item.category==='food'&&item.label.includes('food ration'));assert.ok(food);
  await call("use", {action: "eat", ...sid,itemId: food.id});
  const warning=await call("use", {action: "eat", ...sid,itemId: food.id});
  assert.equal(warning.decision.kind,'confirmation');assert.equal(warning.decision.about,'Continue eating?');
  const death=await call("respond", {action: "answer", ...sid,decisionId:warning.decision.id,value: true});
  assert.equal(death.control.gate,death.scene.end?.kind==='disconnected'?'ownershipLost':'ended');assert.equal(death.scene.end.kind,'death');assert.equal(death.scene.end.cause,'choked on a food ration');
  assert.equal(death.outcome.turnsElapsed,1);
  assert.equal(death.outcome.status,'ended');
  assert.match(death.summary,/^Run ended.*choked on a food ration/);
  const receipt=await call("observe", {...sid,operationId:death.outcome.operationId});
  assert.equal(receipt.result.receipt.outcome.turnsElapsed,death.outcome.turnsElapsed);assert.equal(receipt.result.receipt.outcome.action,death.outcome.action);assert.deepEqual(receipt.result.receipt.end,death.scene.end);
  assert.equal(receipt.result.operationId,death.outcome.operationId);assert.equal(receipt.result.receipt.summary,undefined);
  const observed=await call("observe", sid);
  assert.match(observed.summary,/^Run ended.*choked on a food ration/);
  assert.deepEqual(observed.scene.end,death.scene.end);assert.equal(observed.basis.turn,death.basis.turn);
  const stopped=await call("travel", {mode: "to", ...sid,to:observed.scene.self.position});
  assert.equal(stopped.error.code,'ended');assert.equal(stopped.control.gate,'ended');
  assert.match(stopped.summary,/^Run ended.*choked on a food ration/);
  assert.equal(stopped.outcome.actionsTaken,0);
  assert.deepEqual(stopped.scene.end,death.scene.end);assert.equal(stopped.outcome.operationId,undefined);
  assert.equal(stopped.outcome.submission,'rejected');assert.equal(stopped.outcome.turnsElapsed,0);assert.deepEqual(stopped.events,[]);
});

for(const mode of ['stdio','http','typescript','webmcp'])test(`${mode}: death during a real navigation action leads with cause and preserves its receipt`,{timeout:30000},async t=>{
  const call=withSessionViews(await client(t,mode));
  const start=await call("session", {action: "create", seed:42,name:'Terminal',role:'tourist',race:'human',gender:'female',align:'neutral'});
  const sid={sessionId:start.basis.sessionId},origin=start.scene.self.position,next={x:origin.x,y:origin.y-1};
  assert.deepEqual(origin,{x:18,y:5});
  const rows=start.scene.map.text.split('\n'),row=rows.find(r=>r.startsWith(String(next.y).padStart(3)+' '));
  assert.ok(row&&row[4+next.x-start.scene.map.bounds.x[0]]!==' ','destination is perceived at creation (rendered on the map)');
  // Fresh deterministic engine scenario, using only public actions and hunger.
  // Each interrupted rest is separately requested; no standing decision is answered.
  let state=start;
  for(let i=0;i<40&&state.scene.self.vitals.hunger!=='fainting';i++){
    state=await call("interact", {action: "rest", ...sid,turns:50});
    assert.equal(state.error,undefined);assert.equal(state.decision,null);assert.equal(state.control.gate,'ready');
  }
  assert.equal(state.scene.self.vitals.hunger,'fainting');
  for(let i=0;i<100&&state.control.gate!=='ended';i++){
    const at=state.scene.self.position;
    state=await call("travel", {mode: "to", ...sid,to:at.x===origin.x&&at.y===origin.y?next:origin,maxActions:1});
    assert.equal(state.error,undefined);assert.equal(state.decision,null);
  }
  assert.equal(state.control.gate,state.scene.end?.kind==='disconnected'?'ownershipLost':'ended');assert.equal(state.scene.end.kind,'death');
  assert.equal(state.scene.end.cause,'killed by a fox, while fainted from lack of food');
  assert.equal(state.result.reason,'ended');assert.equal(state.result.actionsTaken,1);assert.equal(state.result.turnsElapsed,12);
  assert.match(state.summary,/^Run ended.*killed by a fox, while fainted from lack of food/);
  assert.equal(state.outcome.status,'ended');assert.equal(state.outcome.turnsElapsed,12);
  const receipt=await call("observe", {...sid,operationId:state.outcome.operationId});
  assert.equal(receipt.result.receipt.outcome.turnsElapsed,state.outcome.turnsElapsed);assert.equal(receipt.result.receipt.outcome.action,state.outcome.action);assert.deepEqual(receipt.result.receipt.end,state.scene.end);
  assert.equal(receipt.result.receipt.summary,undefined);
});
