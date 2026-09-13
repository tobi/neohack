import {contextContracts} from './mcp-context-contracts.mjs';
import assert from 'node:assert/strict';
import {exerciseAgentSyntax} from './agent-syntax-contracts.mjs';
import {AgentClient} from '../dist/mcp/agent.js';
const perceivedFrame=({neighborhood,world,heard,knowledge,...observation})=>observation; // compact replies present world as map
const identity={name:'Agent',seed:42,role:'valkyrie',race:'dwarf',gender:'female',align:'lawful'};
export function agentContracts(test,label,fixture) {
  contextContracts(test,label,fixture);
  test(`${label}: simple discovery syntax covers six question kinds and partial stacks`,async t=>{
    const backend=await fixture(t),agent=new AgentClient(backend.transport);
    await exerciseAgentSyntax((name,args)=>agent.call(name,args));
  });
  test(`${label}: navigation recovery distinguishes the pending input from the last confirmed receipt`,async t=>{
    const b=await fixture(t),moves=[];
    const agent=new AgentClient({send:async request=>{
      const response=await b.transport.send(request);
      if(request.method==='game.move'){
        moves.push(response);
        if(moves.length===2)throw Error('test lost second navigation reply');
      }
      return response;
    }});
    const start=await agent.call("create",{role:'valkyrie',seed:42}),sid={sessionId:start.sessionId};
    const failed=await agent.call('go',{...sid,to:{x:59,y:6}});
    assert.equal(failed.navigation.reason,'error');assert.equal(failed.navigation.actionsTaken,1);
    assert.equal(failed.navigation.turnsElapsed,1);assert.equal(failed.navigation.observation,'lastConfirmed');
    assert.equal(failed.navigation.lastOperationId,moves[0].requestId);
    assert.equal(failed.operationId,moves[1].requestId);assert.notEqual(failed.operationId,failed.navigation.lastOperationId);
    assert.equal(failed.observation.turn,start.observation.turn+1);
    const recovered=await agent.call("syncState",sid);
    assert.equal(recovered.observation.turn,start.observation.turn+2);
    assert.equal(recovered.verification.operationId,moves[1].requestId);
    assert.equal(recovered.verification.status,'settled');
    assert.equal(moves.length,2,'verification never resends a navigation substep');
    assert.deepEqual(recovered.observation.neighborhood,moves[1].observation.neighborhood);
    assert.equal((await agent.call('search',{...sid,turns:1})).error,undefined);
  });
  test(`${label}: named spell choices resolve the standing question without spending input on an unknown alias`,async t=>{
    const b=await fixture(t), agent=new AgentClient(b.transport);
    const created=await agent.call("create",{name:'Mage',seed:42,role:'wizard',race:'human',gender:'female',align:'neutral'});
    assert.ok(!created.error,JSON.stringify(created.error));
    const sid={sessionId:created.sessionId};
    const spell=await agent.call("cast",sid);
    assert.equal(spell.decision.kind,'choice');
    assert.ok(spell.decision.options.every(o=>typeof o.name==='string'&&o.name.length));
    const unknown=await agent.call("answer",{...sid,decisionId:spell.decision.id,value: ['not-a-spell']});
    assert.equal(unknown.clarification.reason,'unknownName');
    assert.equal(unknown.decision.id,spell.decision.id);
    const observed=await agent.call("syncState",sid);
    assert.equal(observed.revision,spell.revision);
    assert.equal(observed.observation.turn,spell.observation.turn);
    const chosen=spell.decision.options.find(o=>spell.decision.options.filter(c=>c.name===o.name).length===1);
    assert.ok(chosen);
    const result=await agent.call("answer",{...sid,decisionId:spell.decision.id,value: [chosen.name]});
    assert.ok(!result.error,JSON.stringify(result.error));
    assert.ok(result.operationId);
    assert.notEqual(result.decision?.id,spell.decision.id);
  });
  test(`${label}: resumed named container decisions reject an old opposite transfer`,async t=>{
    const b=await fixture(t),agent=new AgentClient(b.transport);
    const created=await agent.call("create",{role:'archeologist',seed:13}),sid={sessionId:created.sessionId};
    const sack=created.observation.inventory.find(i=>i.known.identity==='sack');
    const open=()=>agent.call("apply",{...sid,itemId: sack.id});
    const put=await open(),choice=put.decision.options.find(o=>o.transfer==='put'&&o.label.includes('food rations'));
    await agent.call("answer",{...sid,decisionId:put.decision.id,value: [choice.name]});
    const take=await open(),option=take.decision.options.find(o=>o.transfer==='take');assert.equal(option.name,choice.name);
    await agent.call("suspend",sid);assert.deepEqual((await agent.call("resume",sid)).decision,take.decision);
    const stale=await agent.call("answer",{...sid,decisionId:put.decision.id,value: [choice.name]});assert.equal(stale.error?.code,'staleDecision');
    assert.equal((await agent.call("syncState",sid)).observation.turn,take.observation.turn);
    const taken=await agent.call("answer",{...sid,decisionId:take.decision.id,value: [option.name]});
    assert.ok(taken.observation.inventory.some(i=>i.known.identity==='food ration'&&i.quantity===4));
    assert.equal((await agent.call("syncState",sid)).revision,taken.revision);
  });
  test(`${label}: agent profile owns guards, names its tools and keeps decisions explicit`,async t=>{
    const b=await fixture(t), agent=new AgentClient(b.transport);
    assert.ok(agent.tools.some(t=>t.name==='go'));
    assert.ok(!agent.tools.some(t=>t.name==='game_move'));
    assert.ok(!agent.tools.some(t=>t.name==='recover'));
    assert.ok(agent.tools.every(t=>!t.inputSchema.properties.requestId && !t.inputSchema.properties.expectedRevision));
    for(const name of ["answer","cancel"])assert.ok(agent.tools.find(t=>t.name===name).inputSchema.required.includes('decisionId'));
    const help=await agent.call('help');assert.equal(help.tools.length,agent.tools.length);assert.ok(help.tools.every(t=>!t.inputSchema));
    assert.equal((await agent.call('help',{name:'go'})).tool.name,'go');
    const start=await agent.call("create",identity);
    assert.match(start.sessionId,/^[A-Za-z0-9_-]{16}$/);assert.equal(typeof start.summary,'string');
    const sid={sessionId:start.sessionId};
    const lore=await agent.call("lookup",{...sid,name:'floating eye'});
    assert.equal(lore.kind,'lore');assert.equal(lore.found,true);assert.match(lore.summary,/reference text, not an observation/);
    const wait=await agent.call("wait",sid);assert.equal(wait.observation.turn,start.observation.turn+1);assert.ok(wait.operationId);
    const ask=await agent.call("eat",sid);assert.equal(ask.decision.kind,'item');
    const stopped=await agent.call('go',{...sid,to:{x:ask.observation.you.x,y:ask.observation.you.y}});
    assert.equal(stopped.navigation.reason,'decision');assert.equal(stopped.decision.id,ask.decision.id);
    assert.equal(stopped.operationId,undefined);assert.equal(stopped.presentation.fullInputReceipt,undefined);
    assert.equal(stopped.outcome.turnsElapsed,0);assert.deepEqual(stopped.events,[]);
    const cancel=await agent.call("cancel",{...sid,decisionId:ask.decision.id});assert.equal(cancel.decision,null);
    const historical=await agent.call('receipt',{...sid,operationId:wait.operationId});
    assert.equal(historical.historical,true);assert.deepEqual(perceivedFrame(historical.receipt.observation),perceivedFrame(wait.observation));
    assert.equal(historical.observation,undefined);assert.equal(historical.decision,undefined);
    assert.ok(!(await agent.call("wait",sid)).error,'old receipt does not roll the agent revision back');
    const invalid=await agent.call('go',{...sid,to:{x:1,y:1},force:'yes'});assert.equal(invalid.error.code,'invalidParams');
  });
  test(`${label}: agent detects queued and human-shared changes without silently refreshing input`,async t=>{
    const b=await fixture(t), g=await b.api.create(identity), agent=new AgentClient(b.transport), sid={sessionId:g.id};
    await agent.call("syncState",sid);
    const [first,second]=await Promise.all([agent.call("wait",sid),agent.call("wait",sid)]);
    assert.ok(!first.error);assert.equal(second.error.code,'staleRevision');
    await g.observe();await g.wait();
    const stale=await agent.call("wait",sid);assert.equal(stale.error.code,'staleRevision');
    assert.equal((await g.observe()).observation.turn,first.observation.turn+1,'rejected input spends no turn');
    await agent.call("syncState",sid);
    assert.ok(!(await agent.call("wait",sid)).error);
  });
  test(`${label}: syncState verifies a lost input response without dispatching gameplay again`,async t=>{
    const b=await fixture(t);let drop=true, dispatched=0, original;
    const agent=new AgentClient({send:async request=>{
      const response=await b.transport.send(request);
      if(request.method==='game.wait') {dispatched++;if(drop){drop=false;original=response;throw Error('Lost response after input');}}
      return response;
    }});
    const start=await agent.call("create",identity),sid={sessionId:start.sessionId};
    const lost=await agent.call("wait",sid);assert.equal(lost.error.code,'uncertainExecution');assert.equal(lost.operationId,original.requestId);
    const blocked=await agent.call("wait",sid);assert.equal(blocked.error.code,'uncertainExecution');assert.equal(dispatched,1);
    const recovered=await agent.call("syncState",sid);assert.deepEqual(perceivedFrame(recovered.observation),perceivedFrame(original.observation));assert.equal(recovered.verification.operationId,original.requestId);
    assert.equal(dispatched,1);assert.equal((await agent.call("syncState",sid)).verification,undefined);assert.equal(dispatched,1);
    assert.equal((await agent.call("syncState",sid)).observation.turn,original.observation.turn);
  });
  test(`${label}: verification of a lost decision reply returns a newer participant's actual standing question`,async t=>{
    const b=await fixture(t);let drop=true,original;const requests=[];
    const agent=new AgentClient({send:async request=>{
      const response=await b.transport.send(request);
      if(request.method==='decision.answer') {requests.push(structuredClone(request));if(drop){drop=false;original=response;throw Error('Lost committed decision reply');}}
      return response;
    }});
    const start=await agent.call("create",identity),sid={sessionId:start.sessionId};
    const prayer=await agent.call("pray",sid);
    const lost=await agent.call("answer",{...sid,decisionId:prayer.decision.id,value: false});
    assert.equal(lost.error.code,'uncertainExecution');assert.equal(requests.length,1);
    const newer=await b.api.request('game.quit',{...sid,requestId:'other-participant-quit',expectedRevision:original.revision});
    assert.equal(newer.decision.action,'quit');
    const recovered=await agent.call("syncState",sid);assert.equal(recovered.verification.operationId,original.requestId);
    assert.equal(recovered.revision,newer.revision);assert.deepEqual(recovered.decision,newer.decision);
    assert.equal(recovered.reply.arguments.decisionId,newer.decision.id);assert.equal(requests.length,1);
    assert.equal((await agent.call("answer",{...sid,decisionId:prayer.decision.id,value: true})).error.code,'staleDecision');
    const current=await agent.call("syncState",sid);assert.equal(current.ended,false);assert.deepEqual(current.decision,newer.decision);assert.equal(current.observation.turn,newer.observation.turn);
    await agent.call("cancel",{...sid,decisionId:newer.decision.id});
  });
  for(const obscuration of ['error','unknown'])test(`${label}: an explicit ${obscuration} result is settled only by its exact verified receipt`,async t=>{
    const b=await fixture(t); let obscure=true, inputs=0, saved;
    const agent=new AgentClient({send:async request=>{
      const response=await b.transport.send(request);
      if(request.method==='game.wait') {
        inputs++;
        if(obscure) {obscure=false;saved=response;return obscuration==='error'
          ? {version:1,sessionId:response.sessionId,error:{code:'incompleteRequest',message:'Receipt temporarily unavailable'}}
          : {...response,outcome:{...response.outcome,status:'unknown'}};}
      }
      return response;
    }});
    const created=await agent.call("create",identity), sid={sessionId:created.sessionId};
    const uncertain=await agent.call("wait",sid);
    assert.equal(uncertain.error.code,obscuration==='error'?'incompleteRequest':'uncertainExecution');
    assert.deepEqual(uncertain.next,{tool:'syncState',arguments:sid});
    assert.equal((await agent.call("wait",sid)).error.code,'uncertainExecution');
    assert.equal(inputs,1);
    const retry=await agent.call("syncState",sid);
    assert.equal(retry.verification.operationId,saved.requestId);
    assert.deepEqual(perceivedFrame(retry.observation),perceivedFrame(saved.observation));
    assert.equal(inputs,1);
  });
  test(`${label}: cancelled queued calls never submit input`,async t=>{
    const b=await fixture(t);let release, entered;
    const started=new Promise(resolve=>{entered=resolve;});
    const hold=new Promise(resolve=>{release=resolve;});
    let inputs=0;
    const agent=new AgentClient({send:async request=>{
      if(request.method==='game.wait'){inputs++;entered();await hold;}
      return b.transport.send(request);
    }});
    const created=await agent.call("create",identity),sid={sessionId:created.sessionId};
    const first=agent.call("wait",sid);await started;
    const controller=new AbortController();
    const second=agent.call("wait",sid,{signal:controller.signal});
    controller.abort();release();
    assert.ok(!(await first).error);
    assert.match((await second).error.message,/cancelled before submission/);
    assert.equal(inputs,1);
  });
  test(`${label}: after a lost outer reply syncState never guesses an old receipt or rewinds human movement`,async t=>{
    const b=await fixture(t),game=await b.api.create(identity),agent=new AgentClient(b.transport),sid={sessionId:game.id};
    await agent.call("syncState",sid);
    const deliveredToBridge=await agent.call("wait",sid);
    // The transport completed, but an outer browser/MCP bridge lost this reply.
    await game.observe();await game.wait();
    const current=await agent.call("syncState",sid);
    assert.equal(current.verification,undefined);
    assert.equal(current.observation.turn,deliveredToBridge.observation.turn+1);
    const historical=await agent.call("receipt",{...sid,operationId:deliveredToBridge.operationId});
    assert.equal(historical.historical,true);assert.equal(historical.observation,undefined);
    assert.deepEqual(perceivedFrame(historical.receipt.observation),perceivedFrame(deliveredToBridge.observation));
    const next=await agent.call("wait",sid);
    assert.ok(!next.error,'historical recovery does not replace the newer observed revision');
    assert.equal(next.observation.turn,current.observation.turn+1);
  });
  for(const fault of ['missing','wrongId','wrongSession','unreadable'])test(`${label}: ${fault} receipt never clears uncertain input or resends it`,async t=>{
    const b=await fixture(t);let dropped=false,inputs=0;
    const agent=new AgentClient({send:async request=>{
      if(request.method==='game.search')inputs++;
      const response=await b.transport.send(request);
      if(request.method==='game.search'&&!dropped){dropped=true;throw Error('Lost search reply');}
      if(request.method==='session.receipt'){
        if(fault==='unreadable')throw Error('Receipt unavailable');
        if(fault==='missing')return {version:1,error:{code:'receiptUnavailable',message:'Not found'}};
        return {...response,...(fault==='wrongId'?{requestId:'different-input'}:{sessionId:'different-run'})};
      }
      return response;
    }});
    const created=await agent.call('create',identity),sid={sessionId:created.sessionId};
    const lost=await agent.call('search',{...sid,turns:1});
    const observed=await agent.call('syncState',sid);
    assert.equal(observed.error.code,'uncertainExecution');assert.equal(observed.verification.status,'unresolved');
    assert.equal(observed.verification.operationId,lost.operationId);assert.equal(observed.observation.turn,created.observation.turn+1);
    assert.equal((await agent.call('search',{...sid,turns:1})).error.code,'uncertainExecution');
    assert.equal(inputs,1);
  });
  test(`${label}: loss before dispatch cannot turn syncState into the original action`,async t=>{
    const b=await fixture(t);let sent=0;
    const agent=new AgentClient({send:request=>{
      if(request.method==='game.search'){sent++;throw Error('Connection lost before delivery');}
      return b.transport.send(request);
    }});
    const created=await agent.call('create',identity),sid={sessionId:created.sessionId};
    await agent.call('search',{...sid,turns:1});
    for(let i=0;i<2;i++){
      const current=await agent.call('syncState',sid);assert.equal(current.error.code,'uncertainExecution');
      assert.equal(current.observation.turn,created.observation.turn);assert.equal(current.revision,created.revision);
    }
    assert.equal(sent,1);
  });
  test(`${label}: a verified receipt without a fresh scene cannot clear input uncertainty`,async t=>{
    const b=await fixture(t);let lost=false,failObserve=true,inputs=0;
    const agent=new AgentClient({send:async request=>{
      if(request.method==='session.observe'&&lost&&failObserve)throw Error('Current scene unavailable');
      const response=await b.transport.send(request);
      if(request.method==='game.search'){inputs++;if(!lost){lost=true;throw Error('Lost accepted reply');}}
      return response;
    }});
    const start=await agent.call('create',identity),sid={sessionId:start.sessionId};
    await agent.call('search',{...sid,turns:1});
    assert.equal((await agent.call('syncState',sid)).error.code,'uncertainExecution');
    assert.equal((await agent.call('search',{...sid,turns:1})).error.code,'uncertainExecution');
    failObserve=false;
    const resumed=await agent.call('resume',sid);assert.equal(resumed.verification.status,'settled');
    assert.equal(resumed.observation.turn,start.observation.turn+1);assert.equal(inputs,1);
  });
  test(`${label}: known navigation stops need no recovery and historical questions are not executable`,async t=>{
    const b=await fixture(t),agent=new AgentClient(b.transport);
    const start=await agent.call('create',{role:'valkyrie',seed:42}),sid={sessionId:start.sessionId};
    const moved=await agent.call('go',{...sid,to:{x:59,y:6},maxActions:1});
    assert.equal(moved.navigation.actionsTaken,1);assert.equal(moved.error,undefined);
    assert.equal(moved.navigation.recover,undefined);assert.doesNotMatch(moved.summary,/recover/i);
    const current=await agent.call('syncState',sid);assert.deepEqual(current.observation.you,moved.observation.you);
    const prayer=await agent.call('pray',sid);await agent.call('cancel',{...sid,decisionId:prayer.decision.id});
    const history=await agent.call('receipt',{...sid,operationId:prayer.operationId});
    assert.equal(history.observation,undefined);assert.equal(history.reply,undefined);assert.equal(history.cancel,undefined);
    assert.equal(history.receipt.reply,undefined);assert.equal(history.receipt.cancel,undefined);assert.deepEqual(history.receipt.decision,prayer.decision);
    assert.equal((await agent.call('syncState',sid)).decision,null);
  });
}
