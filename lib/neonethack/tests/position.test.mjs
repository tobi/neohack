import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './native-fixture.mjs';

test('food detection exposes a durable position decision instead of a resting command', async t => {
  const {api, sessions, transport} = await fixture(t);
  let game = await api.create({name:'Map',role:'wizard',race:'human',gender:'male',align:'neutral',seed:7});
  const items = await game.read();
  const scroll = items.decision.options.find(item => item.label.includes('scroll of food detection'));
  assert.ok(scroll, 'real starting inventory supplies the detection scroll');
  const viewed = await game.answer(items.decision.id, {kind:'item',item:{id:scroll.id}});
  assert.equal(viewed.decision.kind, 'position');
  assert.equal(viewed.decision.mode, 'browse');
  assert.ok(viewed.observation.heard.some(text=>text.includes('smell food')));
  const turn = viewed.observation.turn;
  assert.deepEqual((await game.observe()).decision, viewed.decision);
  await assert.rejects(game.move('north'), /decision/i);
  const request = {version:1,method:'decision.answer',params:{sessionId:game.id,requestId:'cursor-west',expectedRevision:game.state.revision,decisionId:game.decision.id,answer:{kind:'position',position:'west'}}};
  const moved = await transport.send(request);
  assert.deepEqual(await transport.send(request),moved);
  const conflict = await transport.send({...request,params:{...request.params,answer:{kind:'position',position:'east'}}});
  assert.equal(conflict.error.code,'requestConflict');
  await game.observe();
  assert.equal(moved.observation.turn,turn);
  assert.equal(moved.decision.cursor.x,viewed.decision.cursor.x-1);
  const helped = await game.answer(game.decision.id,{kind:'position',position:'help'});
  assert.equal(helped.decision.kind,'position');
  assert.ok(helped.events.some(event=>event.type==='heard' && event.text.includes('cursor')));
  await game.close(); await transport.close();
  const resumed = await fixture(t,{sessions});
  game = await resumed.api.resume(game.id);
  assert.deepEqual(game.decision,helped.decision);
  const done = await game.answer(game.decision.id,{kind:'position',position:'finish'});
  assert.equal(done.decision,null);
  assert.equal(done.observation.turn,turn+1);
  await game.wait();
  for (const finish of ['cancel','coordinate']) {
    const other = await resumed.api.create({name:'Map',role:'wizard',race:'human',gender:'male',align:'neutral',seed:7});
    const selection = await other.read();
    const scroll = selection.decision.options.find(item=>item.label.includes('scroll of food detection'));
    await other.answer(selection.decision.id,{kind:'item',item:{id:scroll.id}});
    const cursor = other.decision.cursor;
    const result = finish === 'cancel' ? await other.cancel(other.decision.id) : await other.answer(other.decision.id,{kind:'position',position:cursor});
    assert.equal(result.decision,null);
    await other.wait(); await other.close();
  }
});
