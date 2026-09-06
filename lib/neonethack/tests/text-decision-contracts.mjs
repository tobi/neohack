import {test} from 'node:test';
import assert from 'node:assert/strict';
export function textDecisionContracts(label, fixture) {
  test(`${label}: genuine wishing text accepts an explicit answer across pending resume and exact receipts`, async t => {
    const {api,transport} = await fixture(t);
    let game = await api.create({name:'TextWish',seed:42,role:'valkyrie',race:'dwarf',gender:'female',align:'lawful'});
    const wand = game.observation.inventory.find(i => i.category === 'wand');
    assert.ok(wand && wand.label.includes('wand of wishing') && wand.label.includes('(0:1)'), 'actual inventory must disclose the known charged test wand');
    const before = game.observation.turn;
    const foodCount = () => game.observation.inventory.filter(i => i.category === 'food').reduce((n,i) => n+i.quantity,0);
    const foodBefore = foodCount();
    const prompt = await game.zap({id:wand.id});
    assert.equal(prompt.decision.kind, 'text');
    assert.match(prompt.decision.about, /wish/);
    assert.deepEqual(prompt.observation.neighborhood.inputGate, {state:'decision',decisionId:prompt.decision.id});
    await game.close(); game = await api.resume(game.id);
    assert.deepEqual(game.decision, prompt.decision);
    const request = {version:1,method:'decision.answer',params:{sessionId:game.id,requestId:'wish-food-once',expectedRevision:game.state.revision,decisionId:prompt.decision.id,answer:{kind:'text',text:'food ration'}}};
    const result = await transport.send(request);
    assert.equal(result.error, undefined);
    assert.equal(result.decision, null);
    assert.equal(result.ended, false);
    assert.equal(result.outcome.status, 'completed');
    assert.equal(prompt.outcome.turnsElapsed + result.outcome.turnsElapsed, result.observation.turn-before);
    assert.equal(result.observation.turn-before, 1, 'the real zap/wish spends one engine turn');
    assert.deepEqual(await transport.send(request), result);
    await game.observe();
    assert.equal(foodCount(), foodBefore+1, 'the explicit successful text wish creates exactly one actual food ration');
    assert.ok(game.observation.inventory.find(i => i.id === wand.id).label.includes('(0:0)'), 'the actual disclosed wand charge is spent');
    await game.close(); game = await api.resume(game.id);
    assert.deepEqual(await transport.send(request), result, 'old text receipt never creates another object after resume');
    await game.observe(); assert.equal(foodCount(), foodBefore+1);
    await game.close();
  });
}
