/** Target-bound, bounded melee/door intent. No transport or game rules live here.
 *
 * bindIntent(frame, {action, target:{kind:'creature'|'obstacle',x,y},
 *   itemRefs:[], goal:'policy goal token', maxActions:2}) returns allowed/stop facts.
 * Frames must be complete, reconstructed public semantic snapshots; never pass
 * an MCP delta. Targets require current visible perception. Creature IDs are
 * revision-local and are deliberately ignored: matching appearance is permission
 * for this bounded policy, not proof of persistent identity.
 *
 * createIntentQueue(intent).next(latestFrame,{goal}) reserves ONE command.
 * The integration dispatcher maps its descriptor to a named public operation,
 * enforces the returned basis, owns exact request IDs/receipts, and calls
 * settle(confirmedResult) once. Missing/uncertain results must stop the queue;
 * they never authorize retry. next/settle return structured facts and never
 * answer a standing decision. Any stop is permanent; ask policy for a new intent.
 * Only single precise action receipts (revision + 1) are accepted, never
 * navigation or other operations that aggregate multiple inputs.
 */
import { isDeepStrictEqual as equal } from 'node:util';

const stopFact = reason => ({ allowed: false, needsPolicy: true, reason });
const point = p => Number.isSafeInteger(p?.x) && Number.isSafeInteger(p?.y);
const freeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const copy = value => structuredClone(value);

function frameProblem(frame) {
  const o = frame?.observation, v = o?.vitals;
  if (!frame || frame.error || frame.historical || frame.update?.kind === 'delta') return 'uncertainFrame';
  if (![frame.storage, frame.recording].every(s => s === undefined || s?.status === 'ok')) return 'uncertainStorage';
  if (!['completed', 'needsChoice', 'blocked', 'cancelled', 'interrupted'].includes(frame.outcome?.status)) return 'uncertainOutcome';
  if (frame.ended === true || frame.end) return 'ended';
  if (frame.decision) return 'decision';
  if (frame.ended !== false || frame.decision !== null || frame.end !== null
      || typeof frame.sessionId !== 'string' || !frame.sessionId
      || !Number.isSafeInteger(frame.revision) || frame.revision < 0
      || !Number.isSafeInteger(o?.turn) || !point(o?.you)
      || typeof o?.location?.id !== 'string' || !Array.isArray(o?.world)
      || o.world.some(c => !point(c))
      || !Number.isFinite(v?.health) || !Array.isArray(v?.condition)
      || !v.condition.every(c => typeof c === 'string')
      || typeof v.hunger !== 'string' || v.hunger === 'unknown'
      || typeof v.burden !== 'string' || v.burden === 'unknown') return 'uncertainFrame';
  const gates = [frame.inputGate, o.neighborhood?.inputGate];
  if (gates.some(gate => gate !== undefined && gate?.state !== 'ready')) return 'inputUnavailable';
  // Equipment changes matter even when the caller has no explicit item argument.
  if (o.inventoryKnown !== true || o.perception?.inventory !== 'current'
      || o.perception?.equipment !== 'current' || !Array.isArray(o.inventory)
      || o.inventory.some(i => typeof i?.id !== 'string' || !Array.isArray(i.usage))
      || new Set(o.inventory.map(i => i.id)).size !== o.inventory.length) return 'uncertainInventory';
  return null;
}

function targetState(frame, target) {
  const cells = frame.observation.world.filter(c => c.x === target.x && c.y === target.y);
  if (cells.length !== 1 || cells[0].visible !== true
      || cells[0].terrain?.freshness !== 'current') return stopFact('targetUncertain');
  const cell = cells[0];
  if (target.kind === 'creature') {
    const c = cell.occupant;
    if (!c) return stopFact('targetDisappeared');
    if (!['creature', 'ally'].includes(c.kind) || !c.appearance
        || !['hostile', 'peaceful', 'tame'].includes(c.attitude)) return stopFact('targetUncertain');
    return { allowed: true, state: { kind: c.kind, appearance: c.appearance,
      attitude: c.attitude, mark: c.mark, color: c.color } };
  }
  if (cell.occupant) return stopFact('obstacleOccupied');
  return { allowed: true, state: { terrain: cell.terrain, objects: cell.objects ?? [] } };
}

function equipment(frame) {
  return frame.observation.inventory.filter(i => i.usage.length)
    .map(i => ({ id: i.id, usage: [...i.usage].sort() })).sort((a, b) => a.id.localeCompare(b.id));
}

/** A fresh policy decision may bind even after a previous blocked action. */
export function bindIntent(frame, spec) {
  if (!spec || !['attack', 'kick', 'open', 'close'].includes(spec.action)
      || !['creature', 'obstacle'].includes(spec.target?.kind) || !point(spec.target)
      || (spec.action === 'attack' && spec.target.kind !== 'creature')
      || (['open', 'close'].includes(spec.action) && spec.target.kind !== 'obstacle')
      || typeof spec.goal !== 'string' || !spec.goal
      || !Number.isSafeInteger(spec.maxActions) || spec.maxActions < 1 || spec.maxActions > 100
      || !Array.isArray(spec.itemRefs ?? [])
      || !(spec.itemRefs ?? []).every(id => typeof id === 'string' && id)) return stopFact('invalidIntent');
  const problem = frameProblem(frame);
  if (problem) return stopFact(problem);
  const o = frame.observation;
  if (Math.max(Math.abs(o.you.x - spec.target.x), Math.abs(o.you.y - spec.target.y)) !== 1)
    return stopFact('targetNotAdjacent');
  const target = targetState(frame, spec.target);
  if (!target.allowed) return target;
  const refs = spec.itemRefs ?? [];
  const items = refs.map(id => o.inventory.find(i => i.id === id));
  if (items.some(i => !i)) return stopFact('itemUnavailable');
  const intent = freeze(copy({ action: spec.action,
    target: { kind: spec.target.kind, x: spec.target.x, y: spec.target.y }, itemRefs: refs,
    goal: spec.goal, maxActions: spec.maxActions, sessionId: frame.sessionId,
    revision: frame.revision, turn: o.turn, levelId: o.location.id, origin: o.you,
    health: o.vitals.health, condition: [...o.vitals.condition].sort(),
    hunger: o.vitals.hunger, burden: o.vitals.burden,
    equipment: equipment(frame), items, targetState: target.state }));
  return { allowed: true, intent };
}

/** Pure validation. It establishes perceived compatibility, never identity. */
export function validateIntent(intent, frame, { goal } = {}) {
  const problem = frameProblem(frame);
  if (problem) return stopFact(problem);
  if (goal !== intent.goal) return stopFact('goalChanged');
  if (frame.sessionId !== intent.sessionId) return stopFact('sessionChanged');
  if (frame.revision < intent.revision || frame.observation.turn < intent.turn) return stopFact('staleFrame');
  const o = frame.observation, v = o.vitals;
  if (o.location.id !== intent.levelId || !equal(o.you, intent.origin)) return stopFact('positionChanged');
  if (v.health < intent.health || v.hunger !== intent.hunger || v.burden !== intent.burden
      || !equal([...v.condition].sort(), intent.condition)) return stopFact('conditionChanged');
  if (!equal(equipment(frame), intent.equipment)) return stopFact('equipmentChanged');
  for (let n = 0; n < intent.itemRefs.length; n++) {
    const item = o.inventory.find(i => i.id === intent.itemRefs[n]);
    if (!item || !equal(item, intent.items[n])) return stopFact('itemChanged');
  }
  const target = targetState(frame, intent.target);
  if (!target.allowed) return target;
  if (!equal(target.state, intent.targetState)) return stopFact('targetChanged');
  return { allowed: true };
}

/** Default progress policy: an attack attempt is enough for a bounded combat
 * leg; it need not hit. Kicking a still-unchanged obstacle is not progress.
 * An injected synchronous madeProgress({intent,before,result}) may tighten or
 * replace that policy using public facts. It cannot override any other stop.
 */
function defaultProgress({ intent, result }) {
  return intent.target.kind === 'creature'
    && result.outcome.effects.includes(intent.action === 'attack' ? 'attacked' : 'kicked');
}

export function createIntentQueue(boundIntent, { madeProgress = defaultProgress } = {}) {
  const intent = freeze(copy(boundIntent));
  let pending = null, reason = null, actionsIssued = 0, revision = intent.revision;
  let turn = intent.turn;
  const stop = why => {
    reason ??= typeof why === 'string' && why ? why : 'policyStopped';
    return { ...stopFact(reason), actionsIssued };
  };
  return Object.freeze({
    stop,
    next(frame, context) {
      if (reason) return stop(reason);
      if (pending) return stop('unsettledAction');
      const check = validateIntent(intent, frame, context);
      if (!check.allowed) return stop(check.reason);
      if (frame.revision !== revision || frame.observation.turn !== turn) return stop('interveningInput');
      if (actionsIssued >= intent.maxActions) return stop('boundReached');
      pending = copy(frame);
      actionsIssued++;
      return { allowed: true, actionsIssued, command: copy({ action: intent.action,
        target: intent.target, itemRefs: intent.itemRefs, goal: intent.goal,
        basis: { sessionId: intent.sessionId, revision, levelId: intent.levelId, origin: intent.origin } }) };
    },
    settle(result) {
      if (reason) return stop(reason);
      if (!pending) return stop('unexpectedResult');
      const before = pending;
      pending = null;
      const check = validateIntent(intent, result, { goal: intent.goal });
      if (!check.allowed) return stop(check.reason);
      const out = result.outcome;
      if (result.revision !== revision + 1 || out?.action !== intent.action
          || !Number.isSafeInteger(out.turnsElapsed) || out.turnsElapsed < 0
          || result.observation.turn - before.observation.turn !== out.turnsElapsed
          || !Array.isArray(out.effects)) return stop('uncertainResult');
      if (out.status !== 'completed' || out.effects.includes('activityInterrupted')) return stop('actionNotCompleted');
      if (result.observation.vitals.health < before.observation.vitals.health) return stop('conditionChanged');
      if (out.turnsElapsed === 0 || out.reason === 'noProgress') return stop('noProgress');
      let progress;
      try { progress = madeProgress({ intent, before: freeze(before), result: freeze(copy(result)) }); }
      catch { return stop('uncertainProgress'); }
      if (progress !== true) return stop('noProgress');
      revision = result.revision;
      turn = result.observation.turn;
      if (actionsIssued >= intent.maxActions) return stop('boundReached');
      return { allowed: true, actionsIssued };
    },
  });
}
