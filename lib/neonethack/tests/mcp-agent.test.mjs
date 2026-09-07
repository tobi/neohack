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
    const a=await call('explore',{maxActions:3}),b=await js.call('explore',{sessionId:browser.sessionId,maxActions:3});
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
