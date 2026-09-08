import { createDispatcher } from './dispatcher.mjs';
import { validateGuardIdentity } from './identity.mjs';
import { assessProximityThreats } from './perception.mjs';
import { freshEyeBumpEvidence } from './fresh-events.mjs';
import { createRunLifecycle } from './lifecycle.mjs';
import { createProgressBudget } from './progress.mjs';
import { captureWalkTarget, runBoundedWalk } from './walk.mjs';
import { resolveItemSelection, summarizeItems } from './presentation.mjs';
import { renderMap } from './map.mjs';
export { bindIntent, validateIntent, createIntentQueue } from './intent.mjs';

const directions = { north:[0,-1], northeast:[1,-1], east:[1,0], southeast:[1,1],
  south:[0,1], southwest:[-1,1], west:[-1,0], northwest:[-1,-1] };
const meleePossible = new Set(['attack','game_kick','go','explore','descend']);
const itemActions = new Map(['eat','wield','equip','remove','drink','read','zap','drop','throw']
  .map(action => ['game_'+action, action]));
const blocked = (reason, evidence) => Object.assign(new Error(reason), { code:'POLICY_STOP', evidence });
function currentResult(result) {
  if (result?.state?.status!=='current' || !result.state.snapshot || result.state.pendingRequest!==null)
    throw Object.assign(new Error('The receipt does not establish current state; observe or recover explicitly.'),
      {code:'CURRENT_STATE_REQUIRED',sendAttempted:true,result});
  return result.state.snapshot;
}

/**
 * Composed reference policy, not an autonomous player or alternate game API.
 * client is createSnapshotClient(), already bound to one exclusively owned run.
 * operations is a Map of explicitly enabled high-MCP names to strict argument
 * validators. Caller owns transport, compact reconstruction, exact recovery,
 * and each authorized choice. No default generic action or automatic consent.
 * records() returns original paired public trace data for the current connection.
 * Missing fresh bump evidence never overrules perceived eye/unknown proximity.
 */
export function createAgentHarness({ runId, sessionId, client, operations,
  records = () => [], maxAttempts = 8 } = {}) {
  if (client?.sessionId !== sessionId || typeof records !== 'function')
    throw new TypeError('Bind harness and client to the same explicit session.');
  const lifecycle = createRunLifecycle({sessionId});
  const progress = createProgressBudget({maxAttempts});
  const targets = new Map();
  const dispatcher = createDispatcher({runId, client, operations, guard: async ({intent,state}) => {
    const frame = state.snapshot;
    await lifecycle.acceptSnapshot(frame);
    lifecycle.assertAllowed('play');
    if (intent.operation === 'attack' || intent.operation === 'game_kick') {
      let target = intent.args.target;
      if (intent.operation === 'game_kick') {
        const delta = directions[target?.direction];
        if (!delta || !frame.observation.you) throw blocked('Explicit adjacent kick direction required.');
        target = {x:frame.observation.you.x+delta[0], y:frame.observation.you.y+delta[1]};
      }
      validateGuardIdentity({runId, operation:intent.operation==='attack'?'attack':'kick', target,
        expectedSessionId:sessionId, expectedRevision:state.revision}, {runId,snapshot:frame},
      {runId,sessionId:state.sessionId,revision:state.revision,ended:frame.ended,end:frame.end});
    }
    if (meleePossible.has(intent.operation)) {
      const perceived = assessProximityThreats(frame);
      const fresh = freshEyeBumpEvidence({records:records(),snapshot:frame});
      if (perceived.blocked || fresh.kind === 'fresh-eye-bump')
        throw blocked('Melee-capable intent needs a new policy choice.', {perceived,fresh});
    }
    const itemAction = itemActions.get(intent.operation);
    if (itemAction) {
      const selection = resolveItemSelection(frame, {sessionId,revision:state.revision,
        id:intent.args.item?.id,action:itemAction});
      if (!selection.ok) throw blocked('Item selection rejected: '+selection.reason,selection);
    }
    return {status:'OK',runId,sessionId,revision:state.revision};
  }});

  async function dispatch(intent) {
    try {
      const result = await dispatcher(intent);
      await lifecycle.acceptSnapshot(currentResult(result));
      return result;
    } catch (error) {
      if (error.sendAttempted) await lifecycle.disconnect();
      throw error;
    }
  }
  async function view() {
    const state = await client.readSnapshot({requireCurrent:false});
    if (state.status === 'current') await lifecycle.acceptSnapshot(state.snapshot);
    else if (state.status !== 'empty') await lifecycle.disconnect();
    return {state,lifecycle:lifecycle.status(),items:summarizeItems(state.snapshot)};
  }
  async function observe({deliberate=false}={}) {
    // A first observation is explicit, too; automatic polling needs alive state.
    lifecycle.assertAllowed('observe',{deliberate});
    try {
      const result = await client.observe();
      const frame=currentResult(result);
      // Client observation cannot clear an uncertain mutation or resurrect a
      // closed run. An explicit successful read can refresh a read-only failure.
      if (deliberate && lifecycle.status().state === 'disconnected' && !frame.ended)
        await lifecycle.resume(frame,{explicit:true});
      else await lifecycle.acceptSnapshot(frame);
      return result;
    } catch(error) { await lifecycle.disconnect(); throw error; }
  }
  async function recover({deliberate=false}={}) {
    if (deliberate!==true) throw blocked('Exact recovery must be explicitly requested.');
    const before=await client.readSnapshot({requireCurrent:false});
    if (!before.pendingRequest || before.pendingKind==='observe')
      throw blocked('There is no pending gameplay operation to recover.');
    await lifecycle.disconnect();
    const result=await client.recover();
    const frame=currentResult(result);
    if (frame.ended) await lifecycle.acceptSnapshot(frame);
    else await lifecycle.resume(frame,{explicit:true});
    return result;
  }
  async function walk({intent,to,maxActions,override}={}) {
    const {snapshot} = await client.readSnapshot();
    if (typeof intent!=='string'||!intent) throw new TypeError('A stable walking intent key is required.');
    let target=targets.get(intent);
    if (!target) {target=captureWalkTarget(snapshot,to);targets.set(intent,target);}
    else if (target.x!==to?.x||target.y!==to?.y)
      throw blocked('Use a new intent key for a different walking destination.');
    return runBoundedWalk({initialFrame:snapshot,target,maxActions,override,go:async args=>{
      const reservation = progress.begin({intent,snapshot,target});
      if (!reservation.allowed) throw blocked('Navigation budget: '+reservation.reason,reservation);
      try {
        const result = await dispatch({runId,sessionId,expectedRevision:snapshot.revision,
          operation:'go',args:{to:args.to,maxActions:args.maxActions},approved:true});
        const frame=currentResult(result);
        progress.settle(reservation.token,{status:'ok',snapshot:frame});
        return frame;
      } catch(error) {
        progress.settle(reservation.token,{status:error.sendAttempted?'unknown':'error',snapshot});
        throw error;
      }
    }});
  }
  async function executeIntent(queue, {goal}={}) {
    const {snapshot} = await client.readSnapshot();
    const next = queue.next(snapshot,{goal});
    if (!next.allowed) return next;
    const {command} = next;
    const operation = command.action === 'attack' ? 'attack' : 'game_'+command.action;
    let target = {x:command.target.x,y:command.target.y};
    if (command.action !== 'attack') {
      const dx=target.x-snapshot.observation.you.x,dy=target.y-snapshot.observation.you.y;
      const direction=Object.keys(directions).find(k=>directions[k][0]===dx&&directions[k][1]===dy);
      if (!direction) return queue.stop('targetNotAdjacent');
      target={direction};
    }
    try {
      const result=await dispatch({runId,sessionId,expectedRevision:command.basis.revision,
        operation,args:{target},approved:true});
      return {result,continuation:queue.settle(currentResult(result))};
    } catch(error) { queue.stop(error.sendAttempted?'uncertainResult':'dispatchRejected'); throw error; }
  }
  return Object.freeze({dispatch,view,observe,recover,walk,executeIntent,
    lifecycle, map:frame=>renderMap(frame.observation)});
}
