import assert from 'node:assert/strict';

// Shared real-engine scenarios: C picks names; the engine picks legal identities.
export function identityContracts(test, label, fixture) {
  test(`${label}: short random session tokens distinguish identical games and survive resume`, {timeout:30000}, async t => {
    const {api} = await fixture(t);
    const ids = new Set();
    for (let i = 0; i < 4; i++) {
      const game = await api.create({seed:42, name:'Token', role:'valkyrie'});
      assert.match(game.id, /^[A-Za-z0-9_-]{16}$/);
      assert.ok(!ids.has(game.id), 'identical creation inputs must mint distinct tokens');
      ids.add(game.id);
      const state = game.observation;
      await game.close();
      const resumed = await api.resume(game.id);
      assert.equal(resumed.id, game.id);
      assert.deepEqual(resumed.observation, state);
      await resumed.close();
    }
  });
  test(`${label}: empty creation randomizes identity, seed-derived names survive resume and overrides`, {timeout:30000}, async t => {
    const {api} = await fixture(t);
    const nameOf = game => game.observation.vitals.title.trim().split(' the ')[0];
    const random = await api.create();
    assert.equal(random.decision,null);
    assert.match(nameOf(random),/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    assert.ok(random.observation.world.length);
    const saved = random.observation;
    await random.close();
    const resumed = await api.resume(random.id);
    assert.deepEqual(resumed.observation,saved,'resume retains the generated identity');
    await resumed.close();
    const names = new Set(), titles = new Set();
    for(const seed of [0,1,2,42,-42,Number.MAX_SAFE_INTEGER]) {
      const first = await api.create({seed});
      const name = nameOf(first);
      assert.equal(first.decision,null);
      assert.ok(name.length <= 31);
      names.add(name);titles.add(first.observation.vitals.title.trim().split(' the ')[1]);
      await first.close();
      const second = await api.create({seed});
      assert.equal(nameOf(second),name,'name generation is reproducible without engine RNG consumption');
      await second.close();
    }
    assert.ok(names.size >= 4,'different seeds select varied names');
    assert.ok(titles.size > 1,'omitted roles do not silently default to one class');
    const specified = await api.create({seed:42,name:'Custom',role:'valkyrie',race:'dwarf',gender:'female',align:'lawful'});
    assert.equal(nameOf(specified),'Custom');
    assert.match(specified.observation.vitals.title,/Stripling/);
    await specified.close();
    const partial = await api.create({seed:42,role:'valkyrie'});
    assert.match(nameOf(partial),/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    assert.match(partial.observation.vitals.title,/Stripling/);
    assert.equal(partial.decision,null);
    await partial.close();
  });
}
