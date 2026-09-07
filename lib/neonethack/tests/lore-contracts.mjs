import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const identity={name:'Scholar',seed:42,role:'valkyrie',race:'dwarf',gender:'female',align:'lawful'};
export function loreContracts(test,label,fixture){
  test(`${label}: pinned encyclopedia lookup is free and separate from perceived facts`,async t=>{
    const b=await fixture(t),game=await b.api.create(identity);
    const before=structuredClone(game.state);
    const journal=b.sessions?`${b.sessions}/${game.id}/input.log.jsonl`:null;
    const bytes=journal?await readFile(journal,'utf8'):null;
    const eye=await game.lookup('floating eye');
    assert.equal(eye.kind,'lore');assert.equal(eye.found,true);assert.ok(eye.lines.length>2);
    assert.deepEqual((await game.lookup('goblins')).lines,(await game.lookup('goblin')).lines,'engine singular matcher');
    assert.deepEqual((await game.lookup('a floating eye')).lines,eye.lines,'engine article matcher');
    assert.equal((await game.lookup('nothing-matches-this-encyclopedia-entry')).found,false);
    await assert.rejects(game.lookup('   '));
    await assert.rejects(game.lookup('x'.repeat(256)));
    await assert.rejects(game.lookup('floating eye\n'));
    assert.deepEqual(game.state,before,'lore does not adopt a game snapshot');
    if(journal)assert.equal(await readFile(journal,'utf8'),bytes,'no query in input journal');
    await game.eat();const question=structuredClone(game.state);
    for(let i=0;i<20;i++)assert.equal((await game.lookup('floating eye')).found,true);
    const observed=await game.observe();
    assert.deepEqual(observed.decision,question.decision);assert.deepEqual(observed.observation,question.observation);assert.equal(observed.revision,question.revision);
    await game.cancel(game.decision.id);
    const control=await b.api.create(identity);await control.eat();await control.cancel(control.decision.id);
    for(let i=0;i<8;i++){
      const a=await game.wait(),c=await control.wait();
      assert.deepEqual(a.observation,c.observation,'queries do not change subsequent seeded outcomes');
      assert.deepEqual(a.outcome,c.outcome);
    }
  });
}
