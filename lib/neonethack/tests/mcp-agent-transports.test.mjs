import {test} from 'node:test';
import {assertSceneObservation} from './mcp-view-fixture.mjs';
import assert from 'node:assert/strict';
import {identity} from './native-fixture.mjs';
import {mcpClient} from './mcp-client-fixture.mjs';
for(const mode of ['stdio','http'])test(mode+' shared WASM navigation, guards and decisions',async t=>{
  const {call}=await mcpClient(t,mode);
  assert.ok((await call("help", {})).result.tools.every(t=>!t.inputSchema));
  assert.equal((await call("help", {name:'travel'})).result.tool.name,'travel');
  const created=await call("session", {action: "create", ...identity,seed:7}),sid={sessionId:created.basis.sessionId};
  assert.match(created.basis.sessionId,/^[A-Za-z0-9_-]{16}$/);assert.equal(created.update,undefined);
  const wait=await call("interact", {action: "rest", ...(sid)});
  assert.equal(wait.basis.turn-created.basis.turn,wait.outcome.turnsElapsed);
  assert.equal(wait.outcome.turnsElapsed,1,JSON.stringify(wait));
  const ask=await call("use", {action: "eat", ...(sid)});assert.equal(ask.decision.kind,'item');
  const stopped=await call("travel", {mode: "explore", ...(sid)});assert.equal(stopped.error.code,'pendingDecision');assert.equal(stopped.outcome.actionsTaken,0);
  assert.equal(stopped.outcome.operationId,undefined,'a zero-input leg cannot borrow the preceding receipt');
  assert.deepEqual(stopped.events,[]);
  assert.equal(stopped.outcome.submission,'rejected');assert.equal(stopped.outcome.turnsElapsed,0);assert.equal(stopped.control.gate,'decision');
  assert.equal((await call("respond", {action: "cancel", ...sid,decisionId:ask.decision.id})).decision,null);
  const receipt=await call("observe", {...sid,operationId:wait.outcome.operationId});assertSceneObservation(wait,receipt.result.receipt.observation);assert.equal(receipt.result.historical,true);
  const leg=await call("travel", {mode: "explore", ...sid,maxActions:3});assert.ok(!leg.error,JSON.stringify(leg.error));assert.ok(leg.result.actionsTaken<=3);assert.equal(leg.result.kind,'navigationLeg');
  assert.equal((await call("session", {action: "suspend", ...(sid)})).error,undefined);
  const resumed=await call("session", {action: "resume", ...(sid)});assert.deepEqual(resumed.scene.self,leg.scene.self);assert.deepEqual(resumed.scene.inventory,leg.scene.inventory);
  await call("session", {action: "suspend", ...(sid)});
});
for(const mode of ['stdio','http'])test(mode+' seeded WASM ally swaps, door attempts and bounded frontiers',async t=>{
  const {call}=await mcpClient(t,mode);
  // Recorded seed-42 regression: explore used to walk toward the second
  // room's closed door, then fail its malformed door substep and hide the
  // committed walking behind "no operation was sent". Routes now displace the
  // kitten instead of corking on it, so the door leg comes after the eastern
  // rooms are exhausted.
  const room=await call("session", {action: "create", role:'valkyrie',seed:42}),run={sessionId:room.basis.sessionId};
  assert.deepEqual(room.scene.self.position,{x:65,y:4});
  const approach=await call("travel", {mode: "to", ...run,to:{x:59,y:6}});
  assert.equal(approach.basis.turn,7);
  const alreadyThere=await call("travel", {mode: "to", ...run,to:approach.scene.self.position});
  assert.equal(alreadyThere.outcome.operationId,undefined);
  assert.equal(alreadyThere.outcome.turnsElapsed,0);
  assert.deepEqual(alreadyThere.events,[]);
  await call("interact", {action: "open", ...run,target:{direction:'west'}});
  let frame,swaps=0;
  for(let i=0;i<23;i++){
    frame=await call("travel", {mode: "explore", ...run,maxActions:20});
    assert.ok(!frame.error,JSON.stringify(frame.error));
    if(frame.outcome.effects.includes('swappedPlaces'))swaps++;
  }
  assert.ok(swaps>0,'the seeded walk displaces the kitten at least once');
  assert.equal(frame.basis.turn,76);
  const opened=await call("travel", {mode: "explore", ...run,maxActions:20,maxFrontiers:4});
  assert.ok(!opened.error,JSON.stringify(opened.error));
  assert.equal(opened.outcome.action,'open');
  assert.equal(opened.result.actionsTaken,15,'fourteen walking steps and one door attempt');
  assert.equal(opened.result.turnsElapsed,15);
  assert.equal(opened.basis.turn,91);
  assert.deepEqual(opened.scene.self.position,{x:41,y:7});
  const doorRow=opened.scene.map.text.split('\n').find(r=>r.startsWith('  7 '));
  // NetHack's default symset draws an open door as the swung door (- or |), never an invented glyph.
  const doorMark=doorRow[4+40-opened.scene.map.bounds.x[0]];
  assert.ok(doorMark==='-'||doorMark==='|','the opened door is rendered with the engine mark');assert.ok(opened.scene.map.legend[doorMark].includes('open door'));
  const doorCell=(await call("observe", run)).scene.world.find(c=>c.x===40&&c.y===7);
  assert.equal(doorCell?.terrain.type,'openDoor');assert.equal(doorCell?.terrain.mark,doorMark,'JSON terrain.mark is the same engine character the map prints');
  assert.equal((await call("observe", run)).basis.turn,91);
  // More frontiers are explicitly requested; the door attempt above still
  // ended its leg. Now four corridor frontiers share one global action bound.
  const several=await call("travel", {mode: "explore", ...run,maxActions:20,maxFrontiers:4});
  assert.equal(several.result.actionsTaken,4);
  assert.equal(several.result.turnsElapsed,4);
  assert.equal(several.result.reason,'arrived');
  assert.deepEqual(several.scene.self.position,{x:37,y:7});
  const bounded=await call("travel", {mode: "explore", ...run,maxActions:2,maxFrontiers:4});
  assert.equal(bounded.result.actionsTaken,2);
  assert.equal(bounded.result.reason,'stepLimit');
  await call("session", {action: "suspend", ...(run)});
});
