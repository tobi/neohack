import {test} from 'node:test';
import assert from 'node:assert/strict';
const perceivedFrame=({neighborhood,...frame})=>frame;
import {identity} from './native-fixture.mjs';
import {mcpClient} from './mcp-client-fixture.mjs';
for(const mode of ['stdio','http'])test(mode+' shared WASM navigation, guards and decisions',async t=>{
  const {call}=await mcpClient(t,mode);
  assert.ok((await call('help')).tools.every(t=>!t.inputSchema));
  assert.equal((await call('help',{name:'go'})).tool.name,'go');
  const created=await call("create",{...identity,seed:7}),sid={sessionId:created.sessionId};
  assert.match(created.sessionId,/^[A-Za-z0-9_-]{16}$/);assert.equal(created.update,undefined);
  const wait=await call('wait',sid);
  assert.equal(wait.observation.turn-created.observation.turn,wait.outcome.turnsElapsed);
  assert.equal(wait.outcome.turnsElapsed,1,JSON.stringify(wait));
  const ask=await call("eat",sid);assert.equal(ask.decision.kind,'item');
  const stopped=await call('explore',sid);assert.equal(stopped.navigation.reason,'decision');assert.equal(stopped.navigation.actionsTaken,0);
  assert.equal(stopped.operationId,undefined,'a zero-input leg cannot borrow the preceding receipt');
  assert.deepEqual(stopped.events,[]);
  assert.deepEqual(stopped.outcome,{action:'navigation',status:'completed',turnsElapsed:0,positionChanged:false,effects:[]});
  assert.equal((await call("cancel",{...sid,decisionId:ask.decision.id})).decision,null);
  const receipt=await call('receipt',{...sid,operationId:wait.operationId});assert.deepEqual(perceivedFrame(receipt.observation),perceivedFrame(wait.observation));assert.equal(receipt.historical,true);
  const leg=await call('explore',{...sid,maxActions:3});assert.ok(!leg.error,JSON.stringify(leg.error));assert.ok(leg.navigation.actionsTaken<=3);assert.match(leg.summary,/Navigation:/);
  assert.equal((await call("suspend",sid)).error,undefined);
  const resumed=await call("resume",sid);assert.deepEqual(perceivedFrame(resumed.observation),perceivedFrame(leg.observation));
  await call("suspend",sid);

  // Recorded seed-42 regression: explore used to walk seven turns toward the
  // second room's closed door, then fail its malformed door substep and hide
  // the committed walking behind "no operation was sent".
  const room=await call("create",{role:'valkyrie',seed:42}),run={sessionId:room.sessionId};
  assert.deepEqual(room.observation.you,{x:65,y:4});
  const approach=await call('go',{...run,to:{x:59,y:6}});
  assert.equal(approach.observation.turn,7);
  const alreadyThere=await call('go',{...run,to:approach.observation.you});
  assert.equal(alreadyThere.operationId,undefined);
  assert.equal(alreadyThere.outcome.turnsElapsed,0);
  assert.deepEqual(alreadyThere.events,[]);
  await call("open",{...run,target:{direction:'west'}});
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
  assert.equal((await call("observe",run)).observation.turn,33);
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
  await call("suspend",run);
});
