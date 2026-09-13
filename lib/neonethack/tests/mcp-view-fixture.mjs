import assert from 'node:assert/strict';
import {AgentClient} from '../dist/mcp/agent.js';
import {tools} from '../dist/mcp/agent-data.js';

/** Test caller memory only: capture a view at invocation, never refresh or
 * reconstruct replies. Explicit caller viewIds pass through for stale tests. */
export function withSessionViews(call) {
  const views = new Map();
  return async (name, args = {}, ...rest) => {
    const needsView = tools.find(tool => tool.name === name)?.inputSchema.required?.includes('viewId');
    const input = needsView && args.viewId === undefined && views.has(args.sessionId)
      ? {...args, viewId: views.get(args.sessionId)} : args;
    const frame = await call(name, input, ...rest);
    if (frame.basis && !frame.error) views.set(frame.basis.sessionId, frame.basis.viewId);
    return frame;
  };
}
export class TestAgentClient extends AgentClient {
  call = withSessionViews((...args) => super.call(...args));
}
/** Compare perceived facts directly across the low and agent contracts. */
export function assertSceneObservation(frame, observation) {
  assert.equal(frame.basis.turn, observation.turn);
  assert.deepEqual(frame.scene.self.position, observation.you);
  assert.deepEqual(frame.scene.self.location, observation.location);
  const {turn, ...vitals} = observation.vitals;
  assert.deepEqual(frame.scene.self.vitals, vitals);
  for (const key of ['inventory', 'inventoryKnown', 'here', 'perception']) assert.deepEqual(frame.scene[key], observation[key], key);
  if (frame.scene.world !== undefined) assert.deepEqual(frame.scene.world, observation.world);
}
export function assertLowDecision(frame, decision) {
  for (const [key, value] of Object.entries(decision)) assert.deepEqual(frame.decision[key], value, key);
  assert.equal(frame.decision.reply.arguments.decisionId, decision.id);
}
