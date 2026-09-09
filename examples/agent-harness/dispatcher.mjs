// Deliberately limited high-MCP vocabulary. Enabling an operation also requires
// a strict argument validator from the integrating harness (no fallback tool).
export const SUPPORTED_OPERATIONS = Object.freeze([
  'attack', 'go', 'explore', 'descend',
  "wait", "search", "rest", "open", "close",
  "kick", "climb", "moveWithoutAttack", "throw",
  "eat", "pickup", "wield",
  "equip", "remove", "drink", "read", "zap",
  "drop", "answer", "cancel",
]);

export class DispatchError extends Error {
  constructor(code, message, { cause, sendAttempted = false } = {}) {
    super(message, { cause });
    this.name = 'DispatchError';
    this.code = code;
    // True means execution may have occurred. Never retry a new action based
    // on this error: use the client's exact reservation/receipt recovery.
    this.sendAttempted = sendAttempted;
  }
}

const fail = (code, message) => { throw new DispatchError(code, message); };
const record = value => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const text = value => typeof value === 'string' && value.length > 0;
const revision = value => Number.isSafeInteger(value) && value >= 0;
function frozenCopy(value) {
  const copy = structuredClone(value);
  const freeze = node => {
    if (node && typeof node === 'object' && !Object.isFrozen(node)) {
      Object.freeze(node);
      for (const child of Object.values(node)) freeze(child);
    }
    return node;
  };
  return freeze(copy);
}

/**
 * O4 / NEO-50: enforce a guard and ONE explicit bounded action in-process.
 * O1 / NEO-47 (run identity), O2 / NEO-48 (perceived coordinates), and
 * O3 / NEO-49 (action-local heard evidence) remain independent guard fixes.
 * An OK policy result is permission to attempt, never a safety guarantee.
 *
 * createDispatcher({runId, client, guard, operations: Map<name, validator>})
 * returns dispatch({runId, sessionId, expectedRevision, operation, args,
 *                  approved: true}). The user/authorized policy supplies the
 * complete intent, including any exact decision ID and answer; no auto-choice.
 * Each validator(args) must return exactly true, rejecting unknown fields and
 * invalid public arguments. Register only explicitly supported operations.
 *
 * client is the NEO-51 snapshot client, bound to this run's store/session:
 *   execute({name,arguments},{preflight}): holds its one per-run writer lock
 *     across reading current state, awaiting preflight(current), reserving,
 *     sending once, and persisting receipt/state. A preflight throw MUST stop
 *     before reservation/send. The immutable current public envelope is
 *     {sessionId,status:'current',revision,snapshot,pendingRequest:null}.
 *     The client enforces then strips local expectedRevision for high MCP.
 * All writers must use that same client/ownership mechanism; no extra lock here.
 *
 * guard({intent,state}) executes under ownership with immutable copies and must
 * return {status:'OK',runId,sessionId,revision}, matching this invocation. BLOCK,
 * malformed results, missing dependencies and exceptions all prevent send.
 * A guard must be a pure read of public evidence, with no transport capability.
 *
 * Returns the unmodified client result; rejects with DispatchError independently
 * of display output. CLI integration must await dispatch and set nonzero exit
 * status on rejection; never place a separate action after a shell guard.
 * There is no automatic retry, action loop, decision answer, or pretty printer.
 */
export function createDispatcher({ runId, client, guard, operations } = {}) {
  if (!text(runId) || typeof client?.execute !== 'function'
      || typeof guard !== 'function' || !(operations instanceof Map)) {
    fail('CONFIG', 'A bound client, run ID, guard and operation validators are required.');
  }
  const validators = new Map(operations);
  for (const [name, validate] of validators) {
    if (!SUPPORTED_OPERATIONS.includes(name) || typeof validate !== 'function') {
      fail('CONFIG', `Unsupported operation or missing validator: ${name}`);
    }
  }

  function validateIntent(intent) {
    if (!record(intent) || intent.approved !== true) {
      fail('APPROVAL', 'An explicitly approved action is required.');
    }
    const keys = ['runId', 'sessionId', 'expectedRevision', 'operation', 'args', 'approved'];
    if (Object.keys(intent).some(key => !keys.includes(key))) {
      fail('INTENT', 'Unknown intent field.');
    }
    if (intent.runId !== runId || !text(intent.sessionId)
        || !revision(intent.expectedRevision)) {
      fail('IDENTITY', 'Explicit run, session and revision must match the bound run.');
    }
    if (!validators.has(intent.operation)) fail('OPERATION', 'Operation is not enabled.');
    if (!record(intent.args) || ['sessionId', 'expectedRevision', 'requestId', 'operationId']
      .some(key => Object.hasOwn(intent.args, key))) {
      fail('ARGUMENTS', 'Arguments must not override session, revision or receipt identity.');
    }
    if (['go', 'explore', 'descend'].includes(intent.operation)
      && (!Number.isSafeInteger(intent.args.maxActions)
        || intent.args.maxActions < 1 || intent.args.maxActions > 1659)) {
      fail('ARGUMENTS', 'Navigation requires an explicit maxActions bound from 1 to 1659.');
    }
    if (validators.get(intent.operation)(intent.args) !== true) {
      fail('ARGUMENTS', 'Operation arguments did not pass validation.');
    }
  }

  function validateState(state, intent) {
    const snapshot = state?.snapshot;
    if (state?.status !== 'current' || state.pendingRequest !== null) {
      fail('STATE', 'Current state is required; resolve pending or uncertain input first.');
    }
    if (state.sessionId !== intent.sessionId || state.revision !== intent.expectedRevision
      || snapshot?.sessionId !== intent.sessionId || snapshot.revision !== state.revision) {
      fail('IDENTITY', 'Current snapshot session or revision does not match the intent.');
    }
    if (!record(snapshot) || snapshot.version !== 1 || snapshot.error || snapshot.isError
      || snapshot.historical === true || snapshot.update?.kind === 'delta'
      || !record(snapshot.observation) || !revision(snapshot.observation.turn)
      || !text(snapshot.observation.location?.id) || !Array.isArray(snapshot.events)
      || !['completed', 'needsChoice', 'blocked', 'cancelled', 'interrupted'].includes(snapshot.outcome?.status)
      || ['storage', 'recording'].some(key => Object.hasOwn(snapshot, key)
        && snapshot[key]?.status !== 'ok')) {
      fail('STATE', 'Require a settled public snapshot with no error, unresolved delta or durability failure.');
    }
    if (snapshot.ended !== false || snapshot.end !== null
      || !(snapshot.decision === null || (record(snapshot.decision) && text(snapshot.decision.id)))) {
      fail('STATE', 'A nonterminal public snapshot with an explicit decision field is required.');
    }
    const decisionOperation = ["answer", "cancel"].includes(intent.operation);
    if (decisionOperation) {
      if (!snapshot.decision || intent.args.decisionId !== snapshot.decision.id) {
        fail('DECISION', 'Answer or cancellation requires the exact current decision ID.');
      }
    } else if (snapshot.decision !== null) {
      fail('DECISION', 'Resolve the standing decision explicitly before another action.');
    }
    for (const source of [snapshot, snapshot.observation, snapshot.observation.neighborhood]) {
      if (!source || !Object.hasOwn(source, 'inputGate')) continue;
      const gate = source.inputGate;
      if (!record(gate) || (snapshot.decision === null ? gate.state !== 'ready'
        : gate.state !== 'decision' || gate.decisionId !== snapshot.decision.id)) {
        fail('INPUT_GATE', 'Public input gate does not permit this action or exact decision.');
      }
    }
  }

  return async function dispatch(input) {
    let sendAttempted = false;
    let phase = 'INTENT';
    try {
      const intent = frozenCopy(input);
      validateIntent(intent);
      phase = 'CLIENT';
      return await client.execute({ name: intent.operation, arguments: {
        ...intent.args, sessionId: intent.sessionId, expectedRevision: intent.expectedRevision,
      } }, { preflight: async envelope => {
        phase = 'STATE';
        const state = frozenCopy(envelope);
        validateState(state, intent);
        phase = 'GUARD';
        const result = await guard(Object.freeze({ intent, state }));
        if (result?.status !== 'OK') fail('GUARD_BLOCKED', 'Guard did not explicitly allow this action.');
        if (result.runId !== intent.runId || result.sessionId !== intent.sessionId
          || result.revision !== intent.expectedRevision) {
          fail('GUARD_IDENTITY', 'Guard result does not match the action run, session and revision.');
        }
        phase = 'SEND';
        // From this handoff onward a client error may follow actual input.
        sendAttempted = true;
      } });
    } catch (cause) {
      if (cause instanceof DispatchError && !sendAttempted) throw cause;
      throw new DispatchError(phase, `Dispatch failed during ${phase.toLowerCase()}.`, { cause, sendAttempted });
    }
  };
}
