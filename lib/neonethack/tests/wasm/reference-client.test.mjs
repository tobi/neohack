import { WasmTransport } from '../../dist/typescript/wasm.js';
import { referenceContracts } from '../reference-client-contracts.mjs';
referenceContracts('WASM', async t => {
  const transport = await WasmTransport.create(); t.after(() => transport.close());
  return { transport, packageId: transport.buildId };
});
