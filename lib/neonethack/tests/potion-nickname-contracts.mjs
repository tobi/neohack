import {test} from 'node:test';
import assert from 'node:assert/strict';
export function potionNicknameContracts(label, fixture) {
  for (const skip of [false,true]) test(`${label}: consumed potion nickname ${skip?'skip':'answer'} survives resume and exact receipts`, async t => {
    const {api,transport}=await fixture(t);
    let game=await api.create({name:'Ada',role:'valkyrie',race:'human',gender:'female',align:'lawful',seed:34});
    for(const direction of ['east','east','south'])await game.move(direction);
    const floor=game.observation.here.items.find(i=>i.category==='potion');
    assert.ok(floor);
    await game.pickup({id:floor.id});
    const potion=game.observation.inventory.find(i=>i.category==='potion');
    assert.ok(potion);
    const revision=game.state.revision;
    const result=await game.drink({id:potion.id});
    assert.equal(result.decision.kind,'text');
    assert.equal(result.decision.purpose,'consumedPotionNickname');
    assert.match(result.decision.about,/cloudy potion/);
    assert.ok(result.events.some(e=>e.type==='heard'&&e.text.includes('liquid fire')));
    const request={version:1,method:'game.drink',params:{sessionId:game.id,requestId:result.requestId,expectedRevision:revision,item:{id:potion.id}}};
    assert.deepEqual(await transport.send(request),result);
    const decision=result.decision, id=game.id;
    await game.close(); game=await api.resume(id);
    assert.deepEqual(game.decision,decision);
    const completed=skip ? await game.cancel(decision.id) : await game.answer(decision.id,{kind:'text',text:'Velvet Riddle'});
    assert.equal(completed.decision,null);
    assert.equal(game.observation.inventory.some(i=>i.id===potion.id),false,'declining a name does not undo drinking');
  });
}
