import {WasmTransport} from '../../dist/typescript/wasm.js';
import {Neonethack} from '../../dist/typescript/client.js';
import {buildInstrumentedEngine} from './instrumented-engine.mjs';
import {textDecisionContracts} from '../text-decision-contracts.mjs';
textDecisionContracts('WASM', async t => {
  const {workerUrl} = await buildInstrumentedEngine(t,{includePath:`${import.meta.dirname}/../text-decisions.inc`,hook:'text_fixture_prepare();'});
  const transport = await WasmTransport.create({workerUrl}); t.after(() => transport.close());
  return {transport,api:new Neonethack(transport)};
});
