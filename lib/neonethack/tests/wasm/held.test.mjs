import {test} from 'node:test';
import {WasmTransport} from '../../dist/typescript/wasm.js';
import {Neonethack} from '../../dist/typescript/client.js';
import {scenarioEngine} from '../pickup-engine-fixture.mjs';
import {heldContracts} from '../held-contracts.mjs';

test('WASM witnessed held state', async t => {
  const options = await scenarioEngine(t, true, 'held-fixture.inc', 'held_fixture');
  await heldContracts(t, async t => {
    const transport = await WasmTransport.create(options);
    t.after(() => transport.close());
    return {transport, api: new Neonethack(transport)};
  });
});
