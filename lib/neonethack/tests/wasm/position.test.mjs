import {WasmTransport} from '../../dist/typescript/wasm.js';
import {Neonethack} from '../../dist/typescript/client.js';
import {checked} from '../native-fixture.mjs';
import {positionContracts} from '../position-contracts.mjs';
positionContracts('WASM', async t=>{
  const transport=checked(await WasmTransport.create()); t.after(()=>transport.close());
  const api=new Neonethack(transport);
  return {transport,api,restart:async game=>{await game.close(); return {api,game:await api.resume(game.id)};}};
});
