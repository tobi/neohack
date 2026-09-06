import { WasmTransport } from '../../dist/typescript/wasm.js';
import { Neonethack } from '../../dist/typescript/client.js';
import { ordinaryWarningContracts, controlledWarningContracts } from '../warning-contracts.mjs';
import { buildInstrumentedEngine } from './instrumented-engine.mjs';
ordinaryWarningContracts('WASM', async t => {
  const transport = await WasmTransport.create(); t.after(() => transport.close());
  return { transport, api: new Neonethack(transport) };
});
controlledWarningContracts('WASM', async t => {
  const {workerUrl} = await buildInstrumentedEngine(t, {
    includePath: `${import.meta.dirname}/../warning-decisions.inc`,
    hook: 'warning_fixture_prepare();',
  });
  const transport = await WasmTransport.create({workerUrl}); t.after(() => transport.close());
  return { transport, api: new Neonethack(transport) };
});
