import assert from 'node:assert/strict';
const identity = { name: 'Manual', seed: 42, role: 'ranger', race: 'human', gender: 'female', align: 'neutral' };
export function manualActionsContracts(test, fixture, backend) {
  test(`${backend}: throwing retains explicit item and target choices, cancellation and exact receipts across resume`, async t => {
    const {api, transport} = await fixture(t);
    let game = await api.create(identity);
    const before = game.observation.turn;
    const itemChoice = await game.throw();
    assert.equal(itemChoice.decision.kind, 'item');
    assert.equal(itemChoice.observation.turn, before);
    const arrow = itemChoice.decision.options.find(i=>i.quantity > 10);
    assert.ok(arrow);
    await game.close(); game = await api.resume(game.id);
    assert.equal(game.decision.id, itemChoice.decision.id);
    const result = await game.answer(game.decision.id, {kind:'item',item:{id:arrow.id}});
    assert.equal(result.decision?.kind,'target');
    assert.equal(result.observation.turn,before);
    await game.close(); game = await api.resume(game.id);
    assert.equal(game.decision.id,result.decision.id);
    const stale = await transport.send({version:1,method:'decision.answer',params:{sessionId:game.id,requestId:'stale-item',expectedRevision:game.state.revision,decisionId:itemChoice.decision.id,answer:{kind:'item',item:{id:arrow.id}}}});
    assert.equal(stale.error.code,'staleDecision');
    const request = {version:1,method:'decision.answer',params:{sessionId:game.id,requestId:'throw-down',expectedRevision:game.state.revision,decisionId:result.decision.id,answer:{kind:'target',target:{direction:'down'}}}};
    const thrown = await transport.send(request);
    assert.equal(thrown.error,undefined);
    assert.equal(thrown.decision,null);
    assert.ok(thrown.outcome.turnsElapsed >= 1);
    assert.equal(thrown.observation.inventory.find(i=>i.id===arrow.id)?.quantity,arrow.quantity-1);
    assert.deepEqual(await transport.send(request),thrown);
    await game.close(); game = await api.resume(game.id);
    assert.deepEqual(await transport.send(request),thrown);
    const conflict = structuredClone(request); conflict.params.answer.target.direction='up';
    assert.ok((await transport.send(conflict)).error);
    const next = await game.throw({id:arrow.id});
    assert.equal(next.decision?.kind,'target');
    const cancelled = await game.cancel(next.decision.id);
    assert.equal(cancelled.outcome.status,'cancelled');
    assert.equal(cancelled.outcome.turnsElapsed,0);
  });
  test(`${backend}: counted drop selects a partial stack and does not duplicate it on retry`, async t => {
    const {api,transport}=await fixture(t), game=await api.create(identity);
    const arrow=game.observation.inventory.find(i=>i.quantity>10); assert.ok(arrow);
    const request={version:1,method:'game.drop',params:{sessionId:game.id,requestId:'drop-three',expectedRevision:game.state.revision,item:{id:arrow.id,quantity:3}}};
    const result=await transport.send(request);
    assert.equal(result.error,undefined);
    assert.equal(result.decision,null);
    assert.equal(result.observation.inventory.find(i=>i.id===arrow.id)?.quantity,arrow.quantity-3);
    assert.ok(result.observation.here.items.some(i=>i.quantity===3));
    assert.equal(result.outcome.turnsElapsed,1);
    assert.deepEqual(await transport.send(request),result);
  });
  test(`${backend}: counted item selection survives resume and refuses excessive counts without engine input`,async t=>{
    const {api,transport}=await fixture(t);let g=await api.create(identity);await g.drop();assert.equal(g.decision.counted,true);
    const decision=g.decision,arrow=decision.options.find(i=>i.quantity>10),revision=g.state.revision,turn=g.observation.turn;
    const bad={version:1,method:'decision.answer',params:{sessionId:g.id,requestId:'too-many',expectedRevision:revision,decisionId:decision.id,answer:{kind:'item',item:{id:arrow.id,quantity:arrow.quantity+1}}}};
    const rejected=await transport.send(bad);assert.equal(rejected.error.code,'invalidQuantity');assert.deepEqual(rejected.decision,decision);assert.equal(rejected.revision,revision);assert.equal(rejected.observation.turn,turn);
    await g.close();g=await api.resume(g.id);assert.deepEqual(g.decision,decision);
    const r=await g.answer(g.decision.id,{kind:'item',item:{id:arrow.id,quantity:2}});assert.equal(r.decision,null);assert.equal(r.observation.inventory.find(i=>i.id===arrow.id).quantity,arrow.quantity-2);assert.equal(r.outcome.turnsElapsed,1);
  });
  test(`${backend}: applying a wand reaches the real strength check or breaking warning; refusal to offer away from an altar costs no turn`,async t=>{
    const {api}=await fixture(t);
    const game=await api.create({...identity,role:'wizard'});
    const wand=game.observation.inventory.find(i=>i.category==='wand'); assert.ok(wand);
    const result=await game.apply({id:wand.id});
    if (!result.decision) assert.match(result.observation.heard.join('\n'),/strength to break/);
    else { assert.equal(result.decision.kind,'confirmation'); assert.match(result.decision.about,/break/i); }
    const cancel=result.decision ? await game.cancel(result.decision.id) : result;
    assert.equal(cancel.outcome.turnsElapsed,0);
    assert.ok(cancel.observation.inventory.some(i=>i.id===wand.id));
    const offer=await game.offer();
    assert.equal(offer.decision,null);
    assert.equal(offer.ended,false);
    assert.equal(offer.outcome.turnsElapsed,0);
    assert.match(offer.observation.heard.join('\n'),/not .*altar/);
  });
}
