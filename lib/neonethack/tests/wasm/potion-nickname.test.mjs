import {WasmTransport} from '../../dist/typescript/wasm.js';
import {Neonethack} from '../../dist/typescript/client.js';
import {potionNicknameContracts} from '../potion-nickname-contracts.mjs';
potionNicknameContracts('WASM',async t=>{
  const transport=await WasmTransport.create(); t.after(()=>transport.close());
  return {transport,api:new Neonethack(transport)};
});
