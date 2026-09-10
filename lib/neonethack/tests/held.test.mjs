import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './native-fixture.mjs';
import {present} from '../dist/mcp/agent.js';
import {scenarioEngine} from './pickup-engine-fixture.mjs';
import {heldContracts, heldNavigationContract} from './held-contracts.mjs';

test('native witnessed held state', async t => {
  const options = await scenarioEngine(t, false, 'held-fixture.inc', 'held_fixture');
  const frames = await heldContracts(t, t => fixture(t, options));
  await t.test('shared MCP preserves witnessed held state', async()=>{
    for(const frame of frames)assert.deepEqual(present(frame,{},true).observation.vitals,frame.observation.vitals);
  });
  await t.test('shared navigator stops at the same zero-damage hold',async t=>{
    const {AgentClient}=await import('../dist/mcp/agent.js');
    const {transport}=await fixture(t,options);const agent=new AgentClient(transport);
    await heldNavigationContract((name,args)=>agent.call(name,args));
  });
});
