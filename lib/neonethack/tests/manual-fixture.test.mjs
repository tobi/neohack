import {test} from 'node:test';
import {fixture} from './native-fixture.mjs';
import {scenarioEngine} from './pickup-engine-fixture.mjs';
import {manualFixtureContracts} from './manual-fixture-contracts.mjs';
test('native controlled manual command scenarios',async t=>{const options=await scenarioEngine(t,false,'manual-fixture.inc','manual_fixture');await manualFixtureContracts(t,t=>fixture(t,options));});
test('native Amulet acquisition wish and final sacrifice use the same endgame contract as WASM',async t=>{
 const options=await scenarioEngine(t,false,'offer-fixture.inc','offer_fixture');
 const context=await fixture(t,options);const {offerFixtureContract}=await import('./offer-contracts.mjs');await offerFixtureContract(t,context);
});
