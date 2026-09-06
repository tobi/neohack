import assert from 'node:assert/strict';
export async function offerFixtureContract(t,{api,transport}){
 const identity={seed:42,role:'valkyrie',race:'dwarf',gender:'female',align:'lawful'};
 const floorGame=await api.create({...identity,name:'FloorOffering'});
 await floorGame.answer(floorGame.decision.id,{kind:'text',text:'nothing'});
 const corpse=floorGame.observation.here.items.find(i=>i.label.includes('lichen corpse'));assert.ok(corpse);
 const sacrifice=await floorGame.offer({id:corpse.id});assert.equal(sacrifice.decision,null);assert.equal(sacrifice.error,undefined);assert.equal(sacrifice.ended,false);assert.ok(sacrifice.outcome.turnsElapsed>0);assert.ok(!sacrifice.observation.here.items.some(i=>i.id===corpse.id));await floorGame.close();
 const fakeGame=await api.create({...identity,name:'FakeOffering'});const fake=fakeGame.observation.inventory.find(i=>i.category==='amulet');assert.ok(fake);
 const refused=await fakeGame.offer({id:fake.id});assert.equal(refused.decision,null);assert.equal(refused.ended,false);assert.match(refused.observation.heard.join('\n'),/mistake/);assert.ok(refused.outcome.turnsElapsed>0);await fakeGame.close();
 let g=await api.create({name:'Offering',seed:42,role:'valkyrie',race:'dwarf',gender:'female',align:'lawful'});
 /* NetHack 5 grants a wish when the real Amulet is first acquired. The
  * allmain fixture reaches that genuine decision before the first command. */
 assert.equal(g.decision?.kind,'text');assert.match(g.decision.about,/wish/);
 await g.close();g=await api.resume(g.id);
 await g.answer(g.decision.id,{kind:'text',text:'nothing'});
 const amulet=g.observation.inventory.find(i=>i.category==='amulet');assert.ok(amulet);
 await g.offer();assert.equal(g.decision?.kind,'confirmation');await g.answer(g.decision.id,{kind:'confirmation',confirm:false});assert.equal(g.decision?.kind,'item');
 const decision=g.decision;await g.close();g=await api.resume(g.id);assert.deepEqual(g.decision,decision);
 const request={version:1,method:'decision.answer',params:{sessionId:g.id,requestId:'amulet-offering',expectedRevision:g.state.revision,decisionId:g.decision.id,answer:{kind:'item',item:{id:amulet.id}}}};
 const result=await transport.send(request);assert.equal(result.error,undefined);assert.equal(result.ended,true);assert.equal(result.end.kind,'ascended');assert.ok(Number.isSafeInteger(result.end.score));assert.deepEqual(await transport.send(request),result);
 await g.close();g=await api.resume(g.id);assert.deepEqual(g.state.end,result.end);assert.deepEqual(await transport.send(request),result);
}
