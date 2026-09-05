import { fixture } from './native-fixture.mjs';
import { affordanceContracts, doorContracts } from './affordance-contracts.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
const native = async t => {
  const b=await fixture(t);
  b.restart=async game=> { await b.transport.close(); const next=await fixture(t,{sessions:b.sessions}); b.api=next.api; b.transport=next.transport; return b.api.resume(game.id); }; return b;
};
affordanceContracts('native',native);
doorContracts('native',native);
test('actions do not create an unloaded session or write loaded storage', async t=> {
  const b=await fixture(t); const game=await b.api.create({name:'Query',seed:42,role:'valkyrie',race:'dwarf',gender:'female',align:'lawful'});
  const files=await readdir(`${b.sessions}/${game.id}`,{recursive:true});
  const bytes=async()=>Object.fromEntries(await Promise.all(files.filter(p=>/\.(json|jsonl|idx)$|inputs/.test(p)).map(async p=>[p,await readFile(`${b.sessions}/${game.id}/${p}`,'utf8')])));
  const before=await bytes(); for(let i=0;i<30;i++) await game.actions('here'); assert.deepEqual(await bytes(),before);
  await b.transport.close(); const cold=await fixture(t,{sessions:b.sessions});
  const q=await cold.api.request('session.actions',{sessionId:game.id,expectedRevision:game.state.revision,target:'here'}); assert.equal(q.error.code,'unknownSession');
  assert.deepEqual(await bytes(),before);
});

test('SDK captures offered revision and copied arguments while queued, without resolving uncertainty through queries', async t => {
  const b=await native(t); let game=await b.api.create({name:'Queue',seed:42,role:'valkyrie',race:'dwarf',gender:'female',align:'lawful'});
  const revision=game.state.revision, options={expectedRevision:revision};
  const advance=game.wait(), stale=game.search(options); options.expectedRevision=revision+1;
  await advance; await assert.rejects(stale,e=>e.response?.error.code==='staleRevision');
  const send=b.transport.send.bind(b.transport); let seen, lose=true;
  b.transport.send=async request=> { seen=request; const r=await send(request); if(lose && request.method==='game.open') {lose=false; throw Error('lost reply');} return r; };
  await assert.rejects(game.open(),e=>e.name==='UncertainExecution');
  const pending=game.pendingRequest, current=game.state;
  await assert.rejects(game.actions('here'),e=>e.name==='UncertainExecution');
  assert.equal(game.pendingRequest,pending); assert.equal(game.state,current); assert.equal(seen,pending);
  await game.retry(); assert.equal(game.decision.kind,'target');
  await game.cancel(game.decision.id);
  const tool=game.observation.inventory.find(i=>i.category==='food'); const selected={id:tool.id};
  const first=game.wait(), queued=game.drop(selected); selected.id='invented';
  await first; await queued; assert.equal(seen.params.item.id,tool.id);
});

test('query volume leaves seeded continuation and RNG outcomes identical', async t => {
  const one=await fixture(t), two=await fixture(t);
  const identity={name:'Neutrality',seed:42,role:'valkyrie',race:'dwarf',gender:'female',align:'lawful'};
  const a=await one.api.create(identity), b=await two.api.create(identity);
  const size=Buffer.byteLength(JSON.stringify(a.observation.neighborhood));
  assert.ok(size<50000,`bounded neighborhood size ${size}`);
  const begin=performance.now(),timings=[]; for(let i=0;i<100;i++) {const start=performance.now();await a.actions({direction:'south'});timings.push(performance.now()-start);}
  t.diagnostic(`100 native action queries: ${(performance.now()-begin).toFixed(1)} ms; p95 ${timings.sort((a,b)=>a-b)[94].toFixed(2)} ms; neighborhood ${size} bytes`);
  for(const direction of ['south','south','west','west','south','south']) {
    const x=await a.move(direction),y=await b.move(direction);
    assert.deepEqual(x.observation,y.observation); assert.deepEqual(x.events,y.events); assert.deepEqual(x.outcome,y.outcome);
  }
});
