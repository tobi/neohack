import { WasmTransport } from '../../dist/typescript/wasm.js';
import { Neonethack } from '../../dist/typescript/client.js';
import { selfStateContracts } from '../self-state-contracts.mjs';
selfStateContracts('WASM', async t => {
  const transport = await WasmTransport.create(); t.after(() => transport.close());
  return { transport, api: new Neonethack(transport) };
});
