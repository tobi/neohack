import {test} from 'node:test';
import {WasmTransport} from '../../dist/typescript/wasm.js';
import {Neonethack} from '../../dist/typescript/client.js';
import {scenarioEngine} from '../pickup-engine-fixture.mjs';
import {manualFixtureContracts} from '../manual-fixture-contracts.mjs';
test('WASM controlled manual command scenarios',async t=>{
 const options=await scenarioEngine(t,true,'manual-fixture.inc','manual_fixture');
 await manualFixtureContracts(t,async t=>{const transport=await WasmTransport.create(options);t.after(()=>transport.close());return {transport,api:new Neonethack(transport)};});
});
test('WASM isolated high altar executes genuine final offering',async t=>{
 const options=await scenarioEngine(t,true,'offer-fixture.inc','offer_fixture');
 const transport=await WasmTransport.create(options);t.after(()=>transport.close());const api=new Neonethack(transport);
 const {offerFixtureContract}=await import('../offer-contracts.mjs');await offerFixtureContract(t,{api,transport});
});
