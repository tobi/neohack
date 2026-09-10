import {test} from 'node:test';
import assert from 'node:assert/strict';
import {characterStatus} from '../src/character-status.ts';
import {fixture} from '../../../lib/neonethack/tests/native-fixture.mjs';
import {scenarioEngine} from '../../../lib/neonethack/tests/pickup-engine-fixture.mjs';
import {heldContracts} from '../../../lib/neonethack/tests/held-contracts.mjs';

test('human held status agrees with actual native and WebMCP frames', async t => {
  const options = await scenarioEngine(t, false, 'held-fixture.inc', 'held_fixture');
  const frames = await heldContracts(t, child => fixture(child, options));
  assert.ok(frames.some(frame => frame.observation.vitals.condition.includes('held')));
  assert.ok(frames.some(frame => !frame.observation.vitals.condition.includes('held')));
  for (const frame of frames)
    assert.equal(characterStatus(frame.observation).conditions.split(' · ').includes('held'),
      frame.observation.vitals.condition.includes('held'),
      'the shared HUD/character-sheet formatter preserves the witnessed condition');
});
