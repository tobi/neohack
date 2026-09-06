import { WasmTransport } from '../../dist/typescript/wasm.js';
import { Neonethack } from '../../dist/typescript/client.js';
import { semanticPerceptionContracts } from '../semantic-perception-contracts.mjs';
semanticPerceptionContracts('WASM', async t => {
  const transport = await WasmTransport.create();
  t.after(() => transport.close());
  return { transport, api: new Neonethack(transport) };
});
