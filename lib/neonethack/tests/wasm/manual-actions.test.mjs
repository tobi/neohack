import {test} from 'node:test';
import {WasmTransport} from '../../dist/typescript/wasm.js';
import {Neonethack} from '../../dist/typescript/client.js';
import {manualActionsContracts} from '../manual-actions-contracts.mjs';
const fixture = async t => { const transport=await WasmTransport.create();t.after(()=>transport.close());return {transport,api:new Neonethack(transport)}; };
manualActionsContracts(test,fixture,'WASM');
