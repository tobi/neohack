import assert from 'node:assert/strict';
import {defaults} from './pickup-settings-contracts.mjs';

// The fixture removes monsters and places real eligible objects one square east.
// Assert the perceived scene at the genuine mid-move menu, not a later redraw.
export async function pickupPerceptionContract(t, fixture) {
  const {api} = await fixture(t);
  const game = await api.create({name:'PickupSight',role:'valkyrie',race:'human',gender:'female',align:'lawful',seed:43,
    automaticPickup:{...defaults,review:true}});
  await game.cancel(game.decision.id);
  const origin = {...game.observation.you};
  const destination = {x:origin.x+1,y:origin.y};
  const scene = () => {
    const observation = game.observation;
    assert.deepEqual(observation.you,destination);
    for (const cells of [observation.world,observation.neighborhood.cells]) {
      const previous = cells.find(c=>c.x===origin.x && c.y===origin.y);
      const current = cells.find(c=>c.x===destination.x && c.y===destination.y);
      assert.equal(previous.visible,true);
      assert.equal(previous.occupant,undefined,'previous hero square must not become an apparent creature');
      assert.equal(current.occupant?.kind,'self');
      assert.equal(current.occupant?.mark,'@','self must use the current hero display, not the floor object glyph');
      assert.equal(cells.filter(c=>c.occupant?.kind==='self').length,1);
      assert.equal(cells.filter(c=>c.occupant?.kind==='creature').length,0);
    }
  };
  for (const answer of ['cancel','select']) {
    await game.move('east');
    assert.equal(game.decision?.pickupReview,true);
    scene();
    const turn = game.observation.turn, revision = game.state.revision;
    const decision = structuredClone(game.decision);
    await game.observe();
    assert.equal(game.observation.turn,turn);
    assert.equal(game.state.revision,revision);
    assert.deepEqual(game.decision,decision);
    scene();
    if (answer==='cancel') await game.cancel(decision.id);
    else await game.answer(decision.id,{kind:'choice',choose:[decision.options.find(o=>o.suggested).id]});
    assert.equal(game.decision,null);
    scene();
    if (answer==='cancel') {
      await game.move('west');
      if(game.decision) await game.cancel(game.decision.id);
    }
  }
  await game.close();
}
