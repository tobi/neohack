import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {AgentClient, present} from '../dist/mcp/agent.js';

export const heldIdentity = {name:'VisibleHold', seed:42, role:'valkyrie', race:'human', gender:'female', align:'lawful'};
const heard = frame => frame.events.filter(e => e.type === 'heard').map(e => e.text).join('\n');
const isHeld = frame => frame.observation.vitals.condition.includes('held');
async function integrity(context, game) {
  return context.sessions ? readFile(`${context.sessions}/${game.id}/rng.jsonl`, 'utf8') : context.transport.integrity();
}

export async function heldContracts(t, fixture) {
  const frames = [];
  for (const name of ['VisibleHold', 'InvisibleHold']) await t.test(name, async t => {
    const context = await fixture(t), control = await fixture(t);
    const game = await context.api.create({...heldIdentity, name});
    const twin = await control.api.create({...heldIdentity, name});
    const step = async (method, ...args) => {
      const actual = await game[method](...args);
      // Opaque item references belong to each run, even in a paired fixture.
      const twinArgs = method === 'zap'
        ? [{id:twin.observation.inventory.find(i => i.label.includes('release-wand')).id}, args[1]] : args;
      const expected = await twin[method](...twinArgs);
      assert.deepEqual(actual.observation.vitals, expected.observation.vitals);
      assert.deepEqual(await integrity(context, game), await integrity(control, twin),
        'same next core/display RNG fingerprints after free queries');
      frames.push(actual);
      if (name === 'InvisibleHold') assert.doesNotMatch(JSON.stringify(actual), /violet fungus/i,
        'held discloses no invisible holder identity in any public field');
      assert.deepEqual(present(actual, {}, true).observation.vitals, actual.observation.vitals);
      return actual;
    };
    assert.ok(!isHeld(game.state));
    frames.push(structuredClone(game.state));
    let acquired = await step('move', 'east');
    // The invisible variant misses its first sticky attack. Wait explicitly,
    // boundedly for the real second-touch witness; do not inject u.ustuck.
    for (let i=0; i<60 && !/touches you again!/.test(heard(acquired)); i++) {
      assert.ok(!isHeld(acquired), 'no held before the sticky-touch witness');
      acquired = await step('wait');
    }
    assert.match(heard(acquired), /touches you again!/);
    assert.ok(isHeld(acquired), 'held appears in the acquiring action frame');
    const before = await integrity(context, game);
    const inputs = context.sessions ? await readFile(`${context.sessions}/${game.id}/input.log.jsonl`, 'utf8') : null;
    for (let i=0; i<5; i++) {
      const observed = await game.observe();
      assert.deepEqual(observed.observation, acquired.observation);
      assert.equal(observed.revision, acquired.revision);
      await game.actions({direction:'south'});
      await game.route({x:41, y:12});
    }
    if (context.sessions) {
      assert.equal(await integrity(context, game), before);
      assert.equal(await readFile(`${context.sessions}/${game.id}/input.log.jsonl`, 'utf8'), inputs);
    } else assert.deepEqual(await context.transport.integrity(), [], 'free queries enter no engine input boundary');
    const escaped = await step('move', 'south');
    assert.match(heard(escaped), /cannot escape from/);
    assert.equal(escaped.outcome.positionChanged, false);
    assert.equal(escaped.outcome.turnsElapsed, 1);
    assert.deepEqual(escaped.observation.you, acquired.observation.you);
    assert.ok(isHeld(escaped));
    const wand = game.observation.inventory.find(i => i.label.includes('release-wand'));
    assert.ok(wand);
    const released = await step('zap', {id:wand.id}, {direction:'north'});
    assert.equal(released.decision, null);
    assert.ok(!isHeld(released), heard(released));
    assert.match(heard(released), /kill|destroy/);
    const moved = await step('move', 'south');
    assert.equal(moved.outcome.positionChanged, true);
    assert.ok(!isHeld(moved));
  });
  await t.test('WebMCP navigation stops on a hold without health loss', async t => {
    const {transport} = await fixture(t), agent = new AgentClient(transport);
    const call = (name, args) => agent.call(name, args);
    await heldNavigationContract(call);
  });
  return frames;
}

export async function heldNavigationContract(call) {
  // Fixed seed 4: first physical touch misses, second (zero-damage sticky)
  // touch hits. Condition change is the only navigation stop trigger.
  const created = await call("create", {...heldIdentity, seed:4});
  assert.ok(!created.error, JSON.stringify(created));
  const sid = {sessionId:created.sessionId};
  assert.ok(!isHeld(created));
  const to = {x:42, y:10};
  const route = await call("route", {...sid, to});
  assert.equal(route.distance, 2);
  const held = await call('go', {...sid, to, maxActions:5});
  assert.ok(!held.error, JSON.stringify(held));
  assert.equal(held.navigation.reason, 'changed');
  assert.equal(held.navigation.actionsTaken, 1);
  assert.equal(held.navigation.turnsElapsed, 1);
  assert.deepEqual(held.observation.you, {x:41, y:10});
  assert.equal(held.observation.vitals.health, created.observation.vitals.health);
  assert.ok(isHeld(held));
  assert.match(heard(held), /fungus misses![\s\S]*fungus touches you!/);
  const observed = await call("observe", sid);
  assert.deepEqual(observed.observation.vitals, held.observation.vitals);
  assert.deepEqual(observed.observation.you, held.observation.you);
  const receipt = await call('receipt', {...sid, operationId:held.operationId});
  assert.equal(receipt.observation, undefined);
  assert.deepEqual(receipt.receipt.observation.vitals, held.observation.vitals);
  await call("suspend", sid);
}
