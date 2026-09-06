import {test} from 'node:test';
import {fixture} from './native-fixture.mjs';
import {pickupEngine} from './pickup-engine-fixture.mjs';
import {pickupFixtureContracts} from './pickup-fixture-contracts.mjs';
test('native: controlled real pickup and container engine scenarios', async t => {
  const options = await pickupEngine(t);
  await pickupFixtureContracts(t, t => fixture(t, options));
});
