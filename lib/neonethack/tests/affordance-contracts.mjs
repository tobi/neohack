import { test } from 'node:test';
import assert from 'node:assert/strict';
const identity = { name: 'Affordance', seed: 42, role: 'valkyrie', race: 'dwarf', gender: 'female', align: 'lawful' };
const directions = ['north','northeast','east','southeast','south','southwest','west','northwest'];
const indices = [31,32,41,50,49,48,39,30];
export function affordanceContracts(name, fixture) {
  test(`${name}: pure actions match all nine neighborhood cells and preserve decisions and revisions`, async t => {
    const b = await fixture(t); const game = await b.api.create(identity);
    assert.equal((await b.api.describe()).capabilities.affordanceVersion, 1);
    async function check() {
      const before = game.state, n = game.observation.neighborhood;
      assert.equal(n.status, 'available'); assert.equal(n.cells.length,81);
      assert.equal(n.basis.revision,before.revision); assert.deepEqual(n.basis.origin,game.observation.you);
      assert.deepEqual(n.inputGate, game.decision ? {state:'decision',decisionId:game.decision.id} : {state:'ready'});
      for(let i=0;i<81;i++) {
        const c=n.cells[i]; assert.equal(c.dx,i%9-4); assert.equal(c.dy,Math.floor(i/9)-4);
        if(!c.inBounds) { assert.equal(c.terrain,undefined); assert.equal(c.walkable,false); assert.deepEqual(c.actions,[]); }
        for(const a of c.actions) {
          if(a.availability==='outOfReach' || a.availability==='knownBlocked') assert.equal(a.arguments,undefined);
          if(a.availability==='knownBlocked') assert.ok(a.reason);
        }
      }
      for(let i=0;i<9;i++) {
        const r=await game.actions(i===8?'here':{direction:directions[i]});
        assert.equal(r.kind,'actions'); assert.deepEqual(r.cell,n.cells[i===8?40:indices[i]]);
        assert.deepEqual(r.inputGate,n.inputGate); assert.equal(r.observation,undefined);
      }
      assert.equal(game.state,before); assert.equal(game.pendingRequest,null);
      assert.deepEqual((await game.observe()).observation,before.observation);
    }
    await check(); await game.eat(); await check(); await game.cancel(game.decision.id);
    await game.pray(); await check(); await game.cancel(game.decision.id);
    const r=await b.api.request('session.actions',{sessionId:game.id,expectedRevision:game.state.revision+1,target:'here'});
    assert.equal(r.error.code,'staleRevision'); assert.equal(r.observation,undefined);
    for(const target of [{direction:'up'},{direction:'down'},'self',{direction:'n'}, {x:1,y:1}]) {
      const r=await b.api.request('session.actions',{sessionId:game.id,expectedRevision:game.state.revision,target}); assert.equal(r.error.code,'invalidParams');
    }
  });
  test(`${name}: witnessed door evidence, free query, explicit tool confirmation and cold replay`, async t => {
    const b=await fixture(t); let game=await b.api.create({...identity,role:'rogue',race:'human',align:'chaotic'});
    // Seeded start has a public door south of the room; routes use known squares.
    for(const d of ['south','south','west','west']) await game.move(d);
    const q=await game.actions({direction:'south'});
    assert.equal(q.cell.terrain.type,'closedDoor'); assert.equal(q.cell.door.lock,'unknown'); assert.equal(q.cell.walkable,null);
    const pick=game.observation.inventory.find(i=>i.category==='tool' && i.label.includes('lock pick')); assert.ok(pick);
    await game.apply({id:pick.id}); assert.equal(game.decision.kind,'target');
    const targetRequest={version:1,method:'decision.answer',params:{sessionId:game.id,requestId:'tool-target-once',expectedRevision:game.state.revision,decisionId:game.decision.id,answer:{kind:'target',target:{direction:'south'}}}};
    const prompt=await b.transport.send(targetRequest);await game.observe();
    assert.equal(prompt.decision.kind,'confirmation');
    const witnessed=await game.actions({direction:'south'});
    assert.equal(witnessed.cell.door.lock, /Unlock/.test(prompt.decision.about)?'locked':'unlocked');
    assert.equal(witnessed.cell.door.freshness,'witnessed');
    assert.ok(prompt.events.some(e=>e.type==='doorWitness' && e.x===q.cell.x && e.y===q.cell.y));
    const before=game.state;
    game=await b.restart(game);
    assert.deepEqual(game.observation,before.observation); assert.deepEqual(game.decision,before.decision);
    assert.deepEqual(await b.transport.send(targetRequest),prompt);
    await game.answer(game.decision.id,{kind:'confirmation',confirm:false});
    assert.equal((await game.actions({direction:'south'})).cell.door.lock,witnessed.cell.door.lock);
    await game.search();
    assert.equal((await game.actions({direction:'south'})).cell.door.freshness,'remembered');
  });
}

// Deliberate fresh routes established from public observed rooms. No hidden-map
// lookup or modified save supplies their lock state: the subsequent bump does.
export function doorContracts(name, fixture) {
  test(`${name}: actual resistant opening discloses unlocked state without claiming success`, async t => {
    const b=await fixture(t);const game=await b.api.create({...identity,role:'rogue',race:'human',align:'chaotic'});
    for(const d of ['south','west','west','south','south']) await game.move(d);
    let result;
    // Eleven deliberate close/open pairs exercise the seeded resistance branch.
    for(let i=0;i<11;i++) {
      if((await game.actions({direction:'south'})).cell.terrain.type==='openDoor') await game.closeDoor('south');
      result=await game.open('south');
    }
    assert.ok(result.events.some(e=>e.type==='doorWitness' && e.fact==='resisted'));
    assert.equal(result.outcome.status,'blocked');assert.equal(result.outcome.positionChanged,false);
    const q=await game.actions({direction:'south'});assert.equal(q.cell.door.lock,'unlocked');assert.equal(q.cell.walkable,true);
    assert.equal(q.cell.door.freshness,'witnessed');assert.ok(q.cell.actions.some(a=>a.method==='game.open' && a.arguments));
  });
  test(`${name}: untested locked/unlocked doors have equivalent offers until actual bump evidence`, async t => {
    const samples=[];
    for(const [seed,path,direction] of [[1,['north','north','west','west'],'north'],[24,Array(8).fill('east'),'east']]) {
      const b=await fixture(t); let game=await b.api.create({...identity,race:'human',seed});
      for(const d of path) await game.move(d);
      const before=await game.actions({direction});
      assert.equal(before.cell.walkable,null); assert.equal(before.cell.door.lock,'unknown');
      // Remove only public geometric differences between the two real rooms.
      const normalized=structuredClone(before.cell); delete normalized.x;delete normalized.y;delete normalized.dx;delete normalized.dy;
      assert.equal(before.cell.terrain.orientation, seed === 24 ? 'vertical' : 'horizontal');
      delete normalized.terrain.orientation; // disclosed frame axis is geometry, never hidden lock evidence
      for(const a of normalized.actions) {if(a.context){delete a.context.x;delete a.context.y;} if(a.arguments?.direction)a.arguments.direction='compass';if(a.arguments?.target)a.arguments.target.direction='compass';}
      samples.push(normalized);
      const request={version:1,method:'game.move',params:{sessionId:game.id,requestId:'bump-once',expectedRevision:game.state.revision,direction}};
      const receipt=await b.transport.send(request); await game.observe();
      assert.equal(receipt.decision,null); assert.equal(receipt.outcome.positionChanged,false);
      const after=await game.actions({direction});
      if(seed===24) {assert.equal(receipt.outcome.reason,'lockedDoor');assert.equal(after.cell.door.lock,'locked');assert.equal(after.cell.door.freshness,'witnessed');assert.equal(after.cell.walkable,false);}
      else {assert.ok(receipt.outcome.effects.includes('openedDoor'));assert.equal(after.cell.terrain.type,'openDoor');assert.equal(after.cell.walkable,true);}
      game=await b.restart(game); assert.deepEqual(await b.transport.send(request),receipt);
      assert.deepEqual(await game.actions({direction}),after);
    }
    assert.deepEqual(samples[0],samples[1]);
  });
  test(`${name}: closed-unlocked doors retain automatic opening and open-door diagonal restrictions`, async t => {
    const b=await fixture(t);const game=await b.api.create(identity);
    for(const d of ['south','south','west','west'])await game.move(d);
    await game.open('south');
    for(let i=0;i<5 && (await game.actions({direction:'south'})).cell.terrain.type==='openDoor';i++) await game.closeDoor('south');
    const closed=await game.actions({direction:'south'}); assert.equal(closed.cell.door.lock,'unlocked');assert.equal(closed.cell.walkable,true);
    await game.move('south'); assert.equal(game.observation.you.y,7); // only opens, never invents an extra step
    await game.move('south');assert.equal(game.observation.you.y,8);
    const diagonal=await game.actions({direction:'southeast'});assert.equal(diagonal.cell.movement.knownRestriction,'intactDoorDiagonal');
  });
}
