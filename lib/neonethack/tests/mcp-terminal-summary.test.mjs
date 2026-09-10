import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fixture,identity,root} from './native-fixture.mjs';
import {mcpExecutable,startMcpHttp,HTTP_PROTOCOL_VERSION} from './mcp-fixture.mjs';
import {AgentClient,present} from '../dist/mcp/agent.js';
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
  for(const compact of [false,true]){
    const rendered=[];
    for(const [i,frame] of frames.entries()){
      const before=structuredClone(frame),{navigation,...snapshot}=frame;
      const ts=present(snapshot,navigation?{navigation}:{},compact);
      rendered.push(ts);
      assert.deepEqual(frame,before,'presentation leaves its source untouched');
      assert.deepEqual(ts.outcome,frame.outcome);
      assert.deepEqual(ts.end,frame.end);
      assert.equal(ts.ended,frame.ended);
      assert.equal(ts.operationId,frame.requestId??undefined);
      if(frame.ended && frame.end?.kind!=='disconnected'){
        assert.ok(ts.summary.startsWith(`Run ended (${frame.end?.kind??'unknown'})`));
        if(frame.end?.cause)assert.ok(ts.summary.split('.')[0].includes(frame.end.cause));
      }else if(frame.end?.kind==='disconnected')assert.equal(ts.summary,'end_session: completed; 0 turns elapsed.');
    }
    assert.equal(rendered[0].summary,'Run ended (death): killed by a frost giant. rest: completed; 0 turns elapsed.');
    assert.equal(rendered[1].summary,'Run ended (death): killed by a frost giant. Navigation: ended; 1 actions, 0 turns elapsed.');
    assert.equal(rendered[2].summary,'Run ended (death): killed by a frost giant. get_state: completed; 0 turns elapsed.');
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
  const call=await client(t,mode);
  const start=await call("create",{seed:4386,name:'Lifesaving',role:'tourist',race:'human',gender:'female',align:'neutral'});
  const sid={sessionId:start.sessionId};assert.ok(sid.sessionId,JSON.stringify(start));
  const closed=await call("suspend",sid);
  assert.equal(closed.ended,true);assert.equal(closed.end.kind,'disconnected');
  assert.equal(closed.summary,'end_session: completed; 0 turns elapsed.');
  assert.equal(closed.outcome.turnsElapsed,0);
  const resumed=await call("resume",sid);
  assert.equal(resumed.ended,false);assert.equal(resumed.end,null);
  const moved=await call('go',{...sid,to:{x:start.observation.you.x-1,y:start.observation.you.y},maxActions:1});
  const amulet=moved.observation.here.items.find(item=>item.category==='amulet');assert.ok(amulet);
  await call("pickup",{...sid,itemId: amulet.id});
  const waited=await call("wait",sid);
  const food=waited.observation.inventory.find(item=>item.category==='food'&&item.label.includes('food ration'));assert.ok(food);
  await call("eat",{...sid,itemId: food.id});
  const warning=await call("eat",{...sid,itemId: food.id});
  assert.equal(warning.decision.kind,'confirmation');assert.equal(warning.decision.about,'Continue eating?');
  const death=await call("answer",{...sid,decisionId:warning.decision.id,value: true});
  assert.equal(death.ended,true);assert.equal(death.end.kind,'death');assert.equal(death.end.cause,'choked on a food ration');
  assert.equal(death.outcome.turnsElapsed,1);
  assert.equal(death.outcome.status,'completed');
  assert.equal(death.summary,`Run ended (death): choked on a food ration. ${death.outcome.action}: completed; 1 turns elapsed.`);
  const receipt=await call('receipt',{...sid,operationId:death.operationId});
  assert.deepEqual(receipt.outcome,death.outcome);assert.deepEqual(receipt.end,death.end);
  assert.equal(receipt.operationId,death.operationId);assert.equal(receipt.summary,death.summary);
  const observed=await call("observe",sid);
  assert.equal(observed.summary,'Run ended (death): choked on a food ration. get_state: completed; 0 turns elapsed.');
  assert.deepEqual(observed.end,death.end);assert.equal(observed.observation.turn,death.observation.turn);
  const stopped=await call('go',{...sid,to:observed.observation.you});
  assert.equal(stopped.summary,'Run ended (death): choked on a food ration. Navigation: ended; 0 actions, 0 turns elapsed.');
  assert.deepEqual(stopped.navigation,{reason:'ended',actionsTaken:0,turnsElapsed:0});
  assert.deepEqual(stopped.end,death.end);assert.equal(stopped.operationId,undefined);
  assert.deepEqual(stopped.outcome,{action:'navigation',status:'completed',turnsElapsed:0,positionChanged:false,effects:[]});
});

for(const mode of ['stdio','http','typescript','webmcp'])test(`${mode}: death during a real navigation action leads with cause and preserves its receipt`,{timeout:30000},async t=>{
  const call=await client(t,mode);
  const start=await call("create",{seed:42,name:'Terminal',role:'tourist',race:'human',gender:'female',align:'neutral'});
  const sid={sessionId:start.sessionId},origin=start.observation.you,next={x:origin.x,y:origin.y-1};
  assert.deepEqual(origin,{x:18,y:5});
  assert.ok(start.observation.world.some(cell=>cell.x===next.x&&cell.y===next.y),'destination is perceived at creation');
  // Fresh deterministic engine scenario, using only public actions and hunger.
  // Each interrupted rest is separately requested; no standing decision is answered.
  let state=start;
  for(let i=0;i<40&&state.observation.vitals.hunger!=='fainting';i++){
    state=await call("rest",{...sid,turns:50});
    assert.equal(state.error,undefined);assert.equal(state.decision,null);assert.equal(state.ended,false);
  }
  assert.equal(state.observation.vitals.hunger,'fainting');
  for(let i=0;i<100&&!state.ended;i++){
    const at=state.observation.you;
    state=await call('go',{...sid,to:at.x===origin.x&&at.y===origin.y?next:origin,force:true,maxActions:1});
    assert.equal(state.error,undefined);assert.equal(state.decision,null);
  }
  assert.equal(state.ended,true);assert.equal(state.end.kind,'death');
  assert.equal(state.end.cause,'killed by a fox, while fainted from lack of food');
  assert.deepEqual(state.navigation,{reason:'ended',actionsTaken:1,turnsElapsed:12});
  assert.equal(state.summary,'Run ended (death): killed by a fox, while fainted from lack of food. Navigation: ended; 1 actions, 12 turns elapsed.');
  assert.equal(state.outcome.status,'completed');assert.equal(state.outcome.turnsElapsed,12);
  const receipt=await call('receipt',{...sid,operationId:state.operationId});
  assert.deepEqual(receipt.outcome,state.outcome);assert.deepEqual(receipt.end,state.end);
  assert.ok(receipt.summary.startsWith('Run ended (death): killed by a fox, while fainted from lack of food.'));
});
