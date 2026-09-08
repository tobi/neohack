import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fixture, identity} from './native-fixture.mjs';
import {present} from '../dist/mcp/agent.js';
const agentExecutable=process.env.NEONETHACK_AGENT_TEST_EXECUTABLE ?? new URL('../build/native/neonethack-mcp-agent-test',import.meta.url).pathname;

test('native agent presentation preserves actual engine frames and matches WebMCP creature references', async t => {
  const {api}=await fixture(t), game=await api.create(identity);
  const frames=[structuredClone(game.state),await game.wait(),await game.eat()];
  assert.equal(frames.at(-1).decision.kind,'item');
  frames.push(await game.cancel(game.decision.id));
  const query=await game.route({x:game.observation.you.x,y:game.observation.you.y});
  frames.push(query);
  const child=spawn(agentExecutable,['present'],{stdio:['pipe','pipe','pipe']});
  let output='',errors='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>errors+=b);
  child.stdin.end(frames.map(f=>JSON.stringify(f)).join('\n')+'\n');
  const [code]=await once(child,'exit');assert.equal(code,0,errors);
  const rendered=output.trim().split('\n').map(JSON.parse);
  assert.equal(rendered.length,frames.length);
  for(let i=0;i<frames.length;i++){
    const {summary,...actual}=rendered[i],{summary:jsSummary,...expected}=present(frames[i]);
    assert.equal(typeof summary,'string');assert.ok(summary.length);
    assert.deepEqual(actual,expected,'all facts, explicit decisions and reference bindings agree');
  }
});

test('native agent-owned guard construction reaches real engine decisions and exact receipts', async t => {
  const {api,transport}=await fixture(t),game=await api.create(identity);
  const build=async (name,args,revision,operationId,decisionId)=>{
    const child=spawn(agentExecutable,['request'],{stdio:['pipe','pipe','pipe']});
    let output='',errors='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>errors+=b);
    child.stdin.end(JSON.stringify({name,args,revision,operationId,decisionId})+'\n');
    const [code]=await once(child,'exit');assert.equal(code,0,errors);return JSON.parse(output);
  };
  const sid={sessionId:game.id};
  const wait=await build('game_wait',sid,game.state.revision,'native-agent-once');
  const first=await transport.send(wait);assert.equal(first.observation.turn,game.observation.turn+1);
  const stale=await transport.send(await build('game_wait',sid,game.state.revision,'native-agent-stale'));
  assert.equal(stale.error.code,'staleRevision');
  assert.deepEqual(await transport.send(wait),first,'retry the exact adapter-owned operation');
  const ask=await transport.send(await build('game_eat',sid,first.revision,'native-agent-question'));
  assert.equal(ask.decision.kind,'item');
  const cancel=await build('decision_cancel',sid,ask.revision,'native-agent-cancel',ask.decision.id);
  const answered=await transport.send(cancel);assert.equal(answered.decision,null);
  assert.deepEqual(await transport.send(cancel),answered);
});

test('native agent executor preserves queued revisions and binds actual standing decisions', async t => {
  const {mkdtemp,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');const {createInterface}=await import('node:readline');
  const directory=await mkdtemp(`${tmpdir()}/neo33-native-agent-`);
  const root=new URL('../',import.meta.url).pathname;
  const child=spawn(agentExecutable,['execute',`${root}engine/playground/nethack`,`${root}engine/playground`,directory],{stdio:['pipe','pipe','pipe']});
  let errors='';child.stderr.on('data',b=>errors+=b);
  const closed=once(child,'exit');const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
  t.after(async()=>{child.stdin.end();await closed;await rm(directory,{recursive:true,force:true});});
  const call=async(name,args,seen=-1,operationId)=>{
    child.stdin.write(JSON.stringify({name,args,seen,operationId})+'\n');
    const next=await lines.next();assert.equal(next.done,false,errors);return JSON.parse(next.value);
  };
  const created=await call('session_create',identity),sid={sessionId:created.sessionId};
  assert.match(created.sessionId,/^[A-Za-z0-9_-]{16}$/);
  const lore=await call('session_lookup',{...sid,name:'floating eye'},created.revision);
  assert.equal(lore.kind,'lore');assert.equal(lore.found,true);assert.ok(lore.lines.length);
  const wait=await call('game_wait',sid,created.revision,'native-owned-wait');
  assert.equal(wait.observation.turn,created.observation.turn+1);
  const stale=await call('game_wait',sid,created.revision,'native-queued');
  assert.equal(stale.error.code,'staleRevision');
  const asked=await call('game_eat',sid,wait.revision,'native-owned-eat');
  assert.equal(asked.decision.kind,'item');
  const cancel=await call('decision_cancel',sid,asked.revision,'native-owned-cancel');
  assert.equal(cancel.decision,null);
  const historical=await call('receipt',{...sid,operationId:wait.requestId});
  assert.deepEqual(historical,wait);
  const after=await call('game_wait',sid,cancel.revision,'native-after-receipt');
  assert.ok(!after.error,'receipt does not replace the current observation');
  assert.equal(after.observation.turn,wait.observation.turn+1);
  const mage=await call('session_create',{name:'Mage',seed:42,role:'wizard',race:'human',gender:'female',align:'neutral'});
  const wizard={sessionId:mage.sessionId};
  const spells=await call('game_cast',wizard,mage.revision,'spell-menu');
  assert.equal(spells.decision.kind,'choice');
  const unknown=await call('decision_answer',{...wizard,answer:{kind:'choice',choose:['missing']}},spells.revision,'unknown-spell');
  assert.equal(unknown.clarification.reason,'unknownName');
  const first=spells.decision.options[0];assert.ok(first.name);
  const selected=await call('decision_answer',{...wizard,answer:{kind:'choice',choose:[first.name]}},spells.revision,'named-spell');
  assert.ok(!selected.error,JSON.stringify(selected.error));
  assert.equal(selected.requestId,'named-spell');
  assert.notEqual(selected.decision?.id,spells.decision.id);

});

test('native navigation executor agrees with WebMCP bounded exploration and direct movement', async t => {
  const {AgentClient}=await import('../dist/mcp/agent.js');
  const {mkdtemp,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');const {createInterface}=await import('node:readline');
  const directory=await mkdtemp(`${tmpdir()}/neo33-native-navigation-`);
  const root=new URL('../',import.meta.url).pathname;
  const child=spawn(`${root}build/native/neonethack-mcp-agent-test`,['execute',`${root}engine/playground/nethack`,`${root}engine/playground`,directory],{stdio:['pipe','pipe','pipe']});
  let errors='';child.stderr.on('data',b=>errors+=b);const closed=once(child,'exit');
  const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
  t.after(async()=>{child.stdin.end();await closed;await rm(directory,{recursive:true,force:true});});
  let state,operation=0;
  const call=async(name,args={})=>{
    child.stdin.write(JSON.stringify({name,args:{...(state?{sessionId:state.sessionId}:{}),...args},seen:state?.revision??-1,operationId:`leg-${++operation}`})+'\n');
    const next=await lines.next();assert.equal(next.done,false,errors);const response=JSON.parse(next.value);
    if(response.observation)state=response;return response;
  };
  const {transport}=await fixture(t),js=new AgentClient(transport);
  const options={...identity,seed:7};const native=await call('session_create',options),browser=await js.call('session_create',options);
  const compare=(a,b)=>{
    assert.deepEqual(a.error,b.error);
    assert.deepEqual(a.navigation,b.navigation);
    for(const key of ['turn','you','vitals','location','world'])assert.deepEqual(a.observation[key],b.observation[key],key);
    assert.equal(a.decision?.kind,b.decision?.kind);
  };
  compare(native,browser);
  for(let i=0;i<12;i++){
    const options={maxActions:3,...(i>=4?{maxFrontiers:3}:{})};
    const a=await call('explore',options),b=await js.call('explore',{sessionId:browser.sessionId,...options});
    compare(a,b);
    if(a.decision||a.ended)break;
  }
  if(!state.decision&&!state.ended){
    const to={x:state.observation.you.x,y:state.observation.you.y};
    compare(await call('go',{to}),await js.call('go',{sessionId:browser.sessionId,to}));
    const invalid=await call('go',{to:{x:1,y:0},force:true});
    assert.ok(invalid.error,'nonadjacent force is rejected');
  }
});

test('native navigation preserves committed progress when later supervisor retention fails',async t=>{
  const {mkdtemp,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');const {createInterface}=await import('node:readline');
  const directory=await mkdtemp(`${tmpdir()}/neo33-navigation-retention-`);
  const root=new URL('../',import.meta.url).pathname;
  const child=spawn(agentExecutable,['execute',`${root}engine/playground/nethack`,`${root}engine/playground`,directory],{stdio:['pipe','pipe','pipe']});
  let errors='';child.stderr.on('data',b=>errors+=b);const closed=once(child,'exit');
  const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
  t.after(async()=>{child.stdin.end();await closed;await rm(directory,{recursive:true,force:true});});
  let state,operation=0;
  const call=async(name,args={},extra={})=>{
    child.stdin.write(JSON.stringify({name,args:{...(state?{sessionId:state.sessionId}:{}),...args},seen:state?.revision??-1,operationId:`retained-${++operation}`,...extra})+'\n');
    const next=await lines.next();assert.equal(next.done,false,errors);const response=JSON.parse(next.value);
    if(response.observation)state=response;return response;
  };
  const created=await call('session_create',{role:'valkyrie',seed:42});
  assert.deepEqual(created.observation.you,{x:65,y:4});
  const failed=await call('go',{to:{x:59,y:6}},{failReservationAfter:2});
  assert.equal(failed.error.code,'uncertainExecution');
  assert.match(failed.error.message,/Navigation stopped after 1 actions and 1 turns\. Substep error:/);
  assert.equal(failed.navigation.reason,'error');
  assert.equal(failed.navigation.actionsTaken,1);
  assert.equal(failed.navigation.turnsElapsed,1);
  assert.equal(failed.navigation.observation,'lastConfirmed');
  assert.equal(failed.navigation.lastOperationId,'retained-2-1');
  assert.equal(failed.requestId,'retained-2-2','identify the retained uncertain substep, not the prior receipt');
  assert.equal(failed.observation.turn,created.observation.turn+1);
  const prior=await call('receipt',{operationId:failed.navigation.lastOperationId});
  assert.deepEqual(prior.observation,failed.observation);
  const blocked=await call('game_wait');
  assert.equal(blocked.error.code,'uncertainExecution','no new input may replace the pending substep');
  const recovered=await call('retry');
  assert.equal(recovered.requestId,failed.requestId);
  assert.equal(recovered.observation.turn,failed.observation.turn+1,'retry completes only the retained step, never the rest of the leg');
  const duplicate=await call('retry');
  assert.deepEqual(duplicate.observation,recovered.observation);
  const observed=await call('session_observe');
  assert.equal(observed.observation.turn,recovered.observation.turn);
});

test('compact native and WebMCP presentation preserve real decisions and perceived layers', async t => {
  const {api}=await fixture(t), game=await api.create(identity);
  const frames=[structuredClone(game.state),await game.wait(),await game.eat()];
  assert.equal(frames.at(-1).decision.kind,'item');
  const child=spawn(agentExecutable,['present-compact'],{stdio:['pipe','pipe','pipe']});
  let output='',errors='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>errors+=b);
  child.stdin.end(frames.map(f=>JSON.stringify(f)).join('\n')+'\n');
  const [code]=await once(child,'exit');assert.equal(code,0,errors);
  const rendered=output.trim().split('\n').map(JSON.parse);
  for(let i=0;i<frames.length;i++){
    const frame=frames[i],{summary,...actual}=rendered[i],{summary:ignored,...expected}=present(frame,{},true);
    assert.deepEqual(actual,expected);
    assert.deepEqual(actual.observation.world,frame.observation.world);
    assert.deepEqual(actual.decision,frame.decision);
    assert.deepEqual(actual.outcome,frame.outcome);
    assert.deepEqual(actual.events,frame.events.filter(e=>!(e.type==='saw'&&e.kind==='terrain'&&(e.mark==='\\u0000'||e.mark==='\u0000'))));
    assert.equal(actual.observation.neighborhood,undefined);
    assert.equal(actual.presentation.fullObservation,'session_observe');
    assert.equal(frame.observation.neighborhood.status,'available','presentation never mutates engine frame');
  }
  assert.ok(JSON.stringify(rendered[0]).length<JSON.stringify(frames[0]).length*0.5,'initial clear-grid events and attempt matrix are the dominant avoidable payload');
});

test('native MCP navigation stops at a real hunger transition before its next route step',async t=>{
  const {pickupEngine}=await import('./pickup-engine-fixture.mjs');
  const {mkdtemp,rm}=await import('node:fs/promises');
  const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
  const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
  const engine=await pickupEngine(t),root=new URL('../',import.meta.url).pathname;
  const sessions=await mkdtemp('/tmp/nnh-mcp-hunger-');
  const client=new Client({name:'navigation-hunger-test',version:'1'});
  t.after(async()=>{await client.close();await rm(sessions,{recursive:true,force:true});});
  await client.connect(new StdioClientTransport({command:`${root}build/native/neonethack-mcp`,args:[engine.enginePath,`${root}engine/playground`,sessions],stderr:'pipe'}));
  const call=async(name,args)=>{const r=await client.callTool({name,arguments:args});assert.ok(!r.isError,JSON.stringify(r));return r.structuredContent;};
  const created=await call('session_create',{name:'NavigationHunger',role:'valkyrie',race:'human',gender:'female',align:'lawful',seed:42});
  const sid={sessionId:created.sessionId},to={x:created.observation.you.x+2,y:created.observation.you.y};
  assert.equal(created.observation.vitals.hunger,'not_hungry');
  const route=await call('session_route',{...sid,to});assert.equal(route.distance,2);
  const result=await call('go',{...sid,to});
  assert.equal(result.navigation.reason,'changed');assert.equal(result.navigation.actionsTaken,1);
  assert.equal(result.observation.vitals.hunger,'hungry');
  assert.deepEqual(result.observation.you,{x:route.steps[0].x,y:route.steps[0].y});
  await call('session_close',sid);
});
