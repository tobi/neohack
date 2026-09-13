import {contextContracts} from './mcp-context-contracts.mjs';
import assert from 'node:assert/strict';
import {exerciseAgentSyntax} from './agent-syntax-contracts.mjs';
import {assertSceneObservation, assertLowDecision, TestAgentClient as AgentClient} from './mcp-view-fixture.mjs';
import {AgentClient as RawAgentClient} from '../dist/mcp/agent.js';
const identity={name:'Agent',seed:42,role:'valkyrie',race:'dwarf',gender:'female',align:'lawful'};
export function agentContracts(test,label,fixture) {
  contextContracts(test,label,fixture);
  test(`${label}: missing, stale and foreign views reject without gameplay input`,async t=>{
    const b=await fixture(t);let inputs=0;
    const agent=new RawAgentClient({send:request=>{
      if(request.method.startsWith('game.'))inputs++;
      return b.transport.send(request);
    }});
    const start=await agent.call('create',identity),other=await agent.call('create',{...identity,seed:7});
    const sid={sessionId:start.basis.sessionId};
    const missing=await agent.call('wait',sid);
    assert.equal(missing.error.code,'invalidParams');assert.equal(missing.outcome.submission,'rejected');
    const foreign=await agent.call('wait',{...sid,viewId:other.basis.viewId});
    assert.equal(foreign.error.code,'staleView');assert.equal(inputs,0);
    const accepted=await agent.call('wait',{...sid,viewId:start.basis.viewId});
    assert.equal(accepted.error,undefined);assert.equal(inputs,1);
    const stale=await agent.call('wait',{...sid,viewId:start.basis.viewId});
    assert.equal(stale.error.code,'staleView');assert.equal(stale.outcome.submission,'rejected');
    assert.equal(stale.outcome.actionsTaken,0);assert.equal(stale.outcome.operationId,undefined);
    assert.deepEqual(stale.events,[]);assert.equal(inputs,1);
    const current=await agent.call('syncState',sid);
    assert.equal(current.basis.turn,accepted.basis.turn);assert.equal(current.basis.revision,accepted.basis.revision);
    const mixed=await agent.call('step',{...sid,viewId:current.basis.viewId,target:{direction:'east',position:{x:1,y:1}}});
    assert.equal(mixed.error.code,'invalidParams');assert.equal(inputs,1);
  });
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
    const start=await agent.call("create",{role:'valkyrie',seed:42}),sid={sessionId:start.basis.sessionId};
    const failed=await agent.call('go',{...sid,to:{x:59,y:6}});
    assert.equal(failed.result.reason,'error');assert.equal(failed.result.actionsTaken,1);
    assert.equal(failed.result.turnsElapsed,1);assert.equal(failed.control.gate,'recoveryRequired');
    assert.equal(failed.result.lastOperationId,moves[0].requestId);
    assert.equal(failed.outcome.operationId,moves[1].requestId);assert.notEqual(failed.outcome.operationId,failed.result.lastOperationId);
    assert.equal(failed.basis.turn,start.basis.turn+1);
    const recovered=await agent.call("syncState",sid);
    assert.equal(recovered.basis.turn,start.basis.turn+2);
    assert.equal(recovered.verification.operationId,moves[1].requestId);
    assert.equal(recovered.verification.status,'settled');
    assert.equal(moves.length,2,'verification never resends a navigation substep');
    assertSceneObservation(recovered,moves[1].observation);
    assert.equal((await agent.call('search',{...sid,turns:1})).error,undefined);
  });
  test(`${label}: named spell choices resolve the standing question without spending input on an unknown alias`,async t=>{
    const b=await fixture(t), agent=new AgentClient(b.transport);
    const created=await agent.call("create",{name:'Mage',seed:42,role:'wizard',race:'human',gender:'female',align:'neutral'});
    assert.ok(!created.error,JSON.stringify(created.error));
    const sid={sessionId:created.basis.sessionId};
    const spell=await agent.call("cast",sid);
    assert.equal(spell.decision.kind,'choice');
    assert.ok(spell.decision.options.every(o=>typeof o.name==='string'&&o.name.length));
    const unknown=await agent.call("answer",{...sid,decisionId:spell.decision.id,value: ['not-a-spell']});
    assert.equal(unknown.error.code,'invalidParams');assert.equal(unknown.outcome.submission,'rejected');
    assert.equal(unknown.decision.id,spell.decision.id);
    const observed=await agent.call("syncState",sid);
    assert.equal(observed.basis.revision,spell.basis.revision);
    assert.equal(observed.basis.turn,spell.basis.turn);
    const chosen=spell.decision.options.find(o=>spell.decision.options.filter(c=>c.name===o.name).length===1);
    assert.ok(chosen);
    const result=await agent.call("answer",{...sid,decisionId:spell.decision.id,value: [chosen.name]});
    assert.ok(!result.error,JSON.stringify(result.error));
    assert.ok(result.outcome.operationId);
    assert.notEqual(result.decision?.id,spell.decision.id);
  });
  test(`${label}: resumed named container decisions reject an old opposite transfer`,async t=>{
    const b=await fixture(t),agent=new AgentClient(b.transport);
    const created=await agent.call("create",{role:'archeologist',seed:13}),sid={sessionId:created.basis.sessionId};
    const sack=created.scene.inventory.find(i=>i.known.identity==='sack');
    const open=()=>agent.call("apply",{...sid,itemId: sack.id});
    const put=await open(),choice=put.decision.options.find(o=>o.transfer==='put'&&o.label.includes('food rations'));
    await agent.call("answer",{...sid,decisionId:put.decision.id,value: [choice.name]});
    const take=await open(),option=take.decision.options.find(o=>o.transfer==='take');assert.equal(option.name,choice.name);
    await agent.call("suspend",sid);assert.deepEqual((await agent.call("resume",sid)).decision,take.decision);
    const stale=await agent.call("answer",{...sid,decisionId:put.decision.id,value: [choice.name]});assert.equal(stale.error?.code,'staleDecision');
    assert.equal((await agent.call("syncState",sid)).basis.turn,take.basis.turn);
    const taken=await agent.call("answer",{...sid,decisionId:take.decision.id,value: [option.name]});
    assert.ok(taken.scene.inventory.some(i=>i.known.identity==='food ration'&&i.quantity===4));
    assert.equal((await agent.call("syncState",sid)).basis.revision,taken.basis.revision);
  });
  test(`${label}: agent profile owns guards, names its tools and keeps decisions explicit`,async t=>{
    const b=await fixture(t), agent=new AgentClient(b.transport);
    assert.ok(agent.tools.some(t=>t.name==='go'));
    assert.ok(!agent.tools.some(t=>t.name==='game_move'));
    assert.ok(!agent.tools.some(t=>t.name==='recover'));
    assert.ok(agent.tools.every(t=>!t.inputSchema.properties.requestId && !t.inputSchema.properties.expectedRevision));
    for(const name of ["answer","cancel"])assert.ok(agent.tools.find(t=>t.name===name).inputSchema.required.includes('decisionId'));
    const help=await agent.call('help');assert.equal(help.result.tools.length,agent.tools.length);assert.ok(help.result.tools.every(t=>!t.inputSchema));
    assert.equal((await agent.call('help',{name:'go'} )).result.tool.name,'go');
    const start=await agent.call("create",identity);
    assert.match(start.basis.sessionId,/^[A-Za-z0-9_-]{16}$/);assert.equal(typeof start.summary,'string');
    const sid={sessionId:start.basis.sessionId};
    const lore=await agent.call("lookup",{...sid,name:'floating eye'});
    assert.equal(lore.result.kind,'lore');assert.equal(lore.result.found,true);assert.equal(lore.outcome.submission,'notSubmitted');assert.deepEqual(lore.events,[]);
    const wait=await agent.call("wait",sid);assert.equal(wait.basis.turn,start.basis.turn+1);assert.ok(wait.outcome.operationId);
    const ask=await agent.call("eat",sid);assert.equal(ask.decision.kind,'item');
    const stopped=await agent.call('go',{...sid,to:{x:ask.scene.self.position.x,y:ask.scene.self.position.y}});
    assert.equal(stopped.error.code,'pendingDecision');assert.equal(stopped.control.gate,'decision');assert.equal(stopped.decision.id,ask.decision.id);
    assert.equal(stopped.outcome.operationId,undefined);assert.equal(stopped.outcome.submission,'rejected');
    assert.equal(stopped.outcome.turnsElapsed,0);assert.deepEqual(stopped.events,[]);
    const cancel=await agent.call("cancel",{...sid,decisionId:ask.decision.id});assert.equal(cancel.decision,null);
    const historical=await agent.call('receipt',{...sid,operationId:wait.outcome.operationId});
    assert.equal(historical.result.historical,true);assertSceneObservation(wait,historical.result.receipt.observation);
    assert.equal(historical.observation,undefined);assert.equal(historical.decision,null);
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
    assert.equal((await g.observe()).observation.turn,first.basis.turn+1,'rejected input spends no turn');
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
    const start=await agent.call("create",identity),sid={sessionId:start.basis.sessionId};
    const lost=await agent.call("wait",sid);assert.equal(lost.error.code,'uncertainExecution');assert.equal(lost.outcome.operationId,original.requestId);
    const blocked=await agent.call("wait",sid);assert.equal(blocked.error.code,'uncertainExecution');assert.equal(dispatched,1);
    const recovered=await agent.call("syncState",sid);assertSceneObservation(recovered,original.observation);assert.equal(recovered.verification.operationId,original.requestId);
    assert.equal(dispatched,1);assert.equal((await agent.call("syncState",sid)).verification,undefined);assert.equal(dispatched,1);
    assert.equal((await agent.call("syncState",sid)).basis.turn,original.observation.turn);
  });
  test(`${label}: verification of a lost decision reply returns a newer participant's actual standing question`,async t=>{
    const b=await fixture(t);let drop=true,original;const requests=[];
    const agent=new AgentClient({send:async request=>{
      const response=await b.transport.send(request);
      if(request.method==='decision.answer') {requests.push(structuredClone(request));if(drop){drop=false;original=response;throw Error('Lost committed decision reply');}}
      return response;
    }});
    const start=await agent.call("create",identity),sid={sessionId:start.basis.sessionId};
    const prayer=await agent.call("pray",sid);
    const lost=await agent.call("answer",{...sid,decisionId:prayer.decision.id,value: false});
    assert.equal(lost.error.code,'uncertainExecution');assert.equal(requests.length,1);
    const newer=await b.api.request('game.quit',{...sid,requestId:'other-participant-quit',expectedRevision:original.revision});
    assert.equal(newer.decision.action,'quit');
    const recovered=await agent.call("syncState",sid);assert.equal(recovered.verification.operationId,original.requestId);
    assert.equal(recovered.basis.revision,newer.revision);assertLowDecision(recovered,newer.decision);
    assert.equal(recovered.decision.reply.arguments.decisionId,newer.decision.id);assert.equal(requests.length,1);
    assert.equal((await agent.call("answer",{...sid,decisionId:prayer.decision.id,value: true})).error.code,'staleDecision');
    const current=await agent.call("syncState",sid);assert.equal(current.control.gate,'decision');assertLowDecision(current,newer.decision);assert.equal(current.basis.turn,newer.observation.turn);
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
    const created=await agent.call("create",identity), sid={sessionId:created.basis.sessionId};
    const uncertain=await agent.call("wait",sid);
    if(obscuration==='error')assert.equal(uncertain.error.code,'incompleteRequest');
    assert.equal(uncertain.outcome.submission,'unknown');assert.equal(uncertain.control.gate,'recoveryRequired');
    assert.equal((await agent.call("wait",sid)).error.code,'uncertainExecution');
    assert.equal(inputs,1);
    const retry=await agent.call("syncState",sid);
    assert.equal(retry.verification.operationId,saved.requestId);
    assertSceneObservation(retry,saved.observation);
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
    const created=await agent.call("create",identity),sid={sessionId:created.basis.sessionId};
    const first=agent.call("wait",sid);await started;
    const controller=new AbortController();
    const second=agent.call("wait",sid,{signal:controller.signal});
    controller.abort();release();
    assert.ok(!(await first).error);
    assert.match((await second).error.message,/cancelled before submission/i);
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
    assert.equal(current.basis.turn,deliveredToBridge.basis.turn+1);
    const historical=await agent.call("receipt",{...sid,operationId:deliveredToBridge.outcome.operationId});
    assert.equal(historical.result.historical,true);assert.equal(historical.observation,undefined);
    assertSceneObservation(deliveredToBridge,historical.result.receipt.observation);
    const next=await agent.call("wait",sid);
    assert.ok(!next.error,'historical recovery does not replace the newer observed revision');
    assert.equal(next.basis.turn,current.basis.turn+1);
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
    const created=await agent.call('create',identity),sid={sessionId:created.basis.sessionId};
    const lost=await agent.call('search',{...sid,turns:1});
    const observed=await agent.call('syncState',sid);
    assert.equal(observed.error.code,'uncertainExecution');assert.equal(observed.verification.status,'unresolved');
    assert.equal(observed.verification.operationId,lost.outcome.operationId);assert.equal(observed.basis.turn,created.basis.turn+1);
    assert.equal((await agent.call('search',{...sid,turns:1})).error.code,'uncertainExecution');
    assert.equal(inputs,1);
  });
  test(`${label}: loss before dispatch cannot turn syncState into the original action`,async t=>{
    const b=await fixture(t);let sent=0;
    const agent=new AgentClient({send:request=>{
      if(request.method==='game.search'){sent++;throw Error('Connection lost before delivery');}
      return b.transport.send(request);
    }});
    const created=await agent.call('create',identity),sid={sessionId:created.basis.sessionId};
    await agent.call('search',{...sid,turns:1});
    for(let i=0;i<2;i++){
      const current=await agent.call('syncState',sid);assert.equal(current.error.code,'uncertainExecution');
      assert.equal(current.basis.turn,created.basis.turn);assert.equal(current.basis.revision,created.basis.revision);
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
    const start=await agent.call('create',identity),sid={sessionId:start.basis.sessionId};
    await agent.call('search',{...sid,turns:1});
    assert.equal((await agent.call('syncState',sid)).error.code,'uncertainExecution');
    assert.equal((await agent.call('search',{...sid,turns:1})).error.code,'uncertainExecution');
    failObserve=false;
    const resumed=await agent.call('resume',sid);assert.equal(resumed.verification.status,'settled');
    assert.equal(resumed.basis.turn,start.basis.turn+1);assert.equal(inputs,1);
  });
  test(`${label}: known navigation stops need no recovery and historical questions are not executable`,async t=>{
    const b=await fixture(t),agent=new AgentClient(b.transport);
    const start=await agent.call('create',{role:'valkyrie',seed:42}),sid={sessionId:start.basis.sessionId};
    const moved=await agent.call('go',{...sid,to:{x:59,y:6},maxActions:1});
    assert.equal(moved.result.actionsTaken,1);assert.equal(moved.error,undefined);
    assert.equal(moved.result.recover,undefined);assert.doesNotMatch(moved.summary,/recover/i);
    const current=await agent.call('syncState',sid);assert.deepEqual(current.scene.self.position,moved.scene.self.position);
    const prayer=await agent.call('pray',sid);await agent.call('cancel',{...sid,decisionId:prayer.decision.id});
    const history=await agent.call('receipt',{...sid,operationId:prayer.outcome.operationId});
    assert.equal(history.observation,undefined);assert.equal(history.decision,null);assert.equal(history.cancel,undefined);
    assert.equal(history.result.receipt.decision.reply,undefined);assert.equal(history.result.receipt.cancel,undefined);assertLowDecision(prayer,history.result.receipt.decision);
    assert.equal((await agent.call('syncState',sid)).decision,null);
  });
}
