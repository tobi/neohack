/**
 * Action-local perceived evidence only; this module never authorizes an action.
 *
 * Supply ordered, settled public trace pairs {request, response} (the library's
 * PublicTrace format), or one connection's serialized MCP JSON-RPC records
 * {direction: 'request'|'response', message}. Do not mix formats or filter out
 * errors/queries. Responses must be original replies, not cached state merged
 * with newer events. A later pending/uncertain call invalidates earlier evidence.
 * The client notifications/initialized message is allowed without a call ID;
 * other notifications or malformed records are rejected, never filtered out.
 *
 * snapshot is the current public {sessionId, revision}; MCP adapters own their
 * input revisions, so these are checked against the reply. Low protocol pairs
 * additionally require exact requestId and an advancing expectedRevision.
 * Unknown adjacency belongs to the caller's perception guard and must remain
 * separately labelled uncertainty even when this helper finds no fresh bump.
 */

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => (typeof value === 'string' && value.length > 0)
  || (typeof value === 'number' && Number.isSafeInteger(value));
const revision = value => Number.isSafeInteger(value) && value >= 0;

function initializedNotification(row) {
  const message = row.message;
  return row.direction === 'request' && message.jsonrpc === '2.0'
    && !Object.hasOwn(message, 'id')
    && Object.keys(message).every(key => ['jsonrpc', 'method', 'params'].includes(key))
    && (!Object.hasOwn(message, 'params') || (object(message.params)
      && Object.keys(message.params).every(key => key === '_meta')
      && (!Object.hasOwn(message.params, '_meta') || object(message.params._meta))));
}

/** Return the latest matched pair, including error replies, or null. Never
 * search backwards for a successful action after a query/error/uncertain call.
 * MCP IDs must be unique within this connection's supplied record sequence.
 */
export function latestCompletedPair(records) {
  if (!Array.isArray(records) || records.length === 0) return null;
  if (Object.hasOwn(records.at(-1) ?? {}, 'request')) {
    const last = records.at(-1);
    if (!records.every(row => object(row) && Object.hasOwn(row, 'request'))
        || last.result === 'transportUncertain'
        || !object(last.request) || !object(last.response)) return null;
    return { request: last.request, response: last.response };
  }
  const pending = new Map(), seen = new Set();
  let latest = null;
  for (const row of records) {
    if (!object(row) || !object(row.message) || row.result === 'transportUncertain') return null;
    const message = row.message;
    if (message.method === 'notifications/initialized') {
      if (!initializedNotification(row)) return null;
      continue;
    }
    if (!id(message.id)) return null;
    if (row.direction === 'request') {
      if (seen.has(message.id) || pending.size) return null;
      seen.add(message.id);
      pending.set(message.id, message);
      latest = null;
    } else if (row.direction === 'response') {
      const request = pending.get(message.id);
      if (!request) return null;
      pending.delete(message.id);
      latest = { request, response: message };
    } else return null;
  }
  return pending.size ? null : latest;
}

function unpack(pair) {
  const { request, response } = pair;
  if (request.method === 'tools/call') {
    if (!id(request.id) || request.id !== response.id) return null;
    return {
      method: request.params?.name,
      params: request.params?.arguments,
      frame: response.result?.structuredContent,
      error: response.error || response.result?.isError,
      mcp: true,
      callId: request.id,
    };
  }
  return { method: request.method, params: request.params, frame: response, error: response.error, mcp: false };
}

// Explicit public operation mappings, not substrings or the reply's claim alone.
const movements = new Map([
  ['game.move', 'move'], ['game.moveWithoutAttack', 'moveWithoutAttack'],
  ["moveWithoutAttack", 'moveWithoutAttack'], ['go', 'move'],
]);

/**
 * Return {kind, reason, evidence}. Positive evidence is a witnessed message at
 * one revision, not a claim that a real eye still occupies a particular square.
 * No events are read from observation.heard, and no position/identity is guessed.
 * A completed movement can still bump. Zero elapsed turns are retained honestly;
 * operation family, status and the action-local message establish the evidence.
 * Multi-action navigation, decision continuations and historical receipts are
 * deliberately unsupported: their initiating action needs additional context.
 */
export function freshEyeBumpEvidence({ records, snapshot } = {}) {
  const absent = reason => ({ kind: 'no-fresh-eye-bump', reason, evidence: null });
  const pair = latestCompletedPair(records);
  if (!pair) return absent('no-completed-pair');
  const call = unpack(pair);
  if (!call) return absent('unmatched-reply');
  const { method, params, frame, error, mcp, callId } = call;
  if (error || frame?.error) return absent('latest-response-error');
  if (!object(frame) || !object(params)) return absent('missing-frame');
  if (frame.historical === true) return absent('historical-receipt');
  if (typeof snapshot?.sessionId !== 'string' || !snapshot.sessionId
      || params.sessionId !== snapshot.sessionId || frame.sessionId !== snapshot.sessionId)
    return absent('session-mismatch');
  if (!revision(snapshot.revision) || !revision(frame.revision) || frame.revision !== snapshot.revision)
    return absent('revision-mismatch');
  if (!mcp && (typeof params.requestId !== 'string' || !params.requestId
      || params.requestId !== frame.requestId)) return absent('request-id-mismatch');
  if ((!mcp || Object.hasOwn(params, 'expectedRevision'))
      && (!revision(params.expectedRevision) || params.expectedRevision >= frame.revision))
    return absent('input-revision-mismatch');
  const action = movements.get(method);
  if (!action || frame.outcome?.action !== action) return absent('unrelated-operation');
  if (method === 'go' && frame.navigation?.actionsTaken !== 1)
    return absent('navigation-not-single-action');
  const outcome = frame.outcome;
  if (!['completed', 'blocked'].includes(outcome.status)
      || outcome.positionChanged !== false
      || !revision(outcome.turnsElapsed)) return absent('unwitnessed-outcome');
  const event = (Array.isArray(frame.events) ? frame.events : []).find(event => event?.type === 'heard'
    && event.textWindow !== true && typeof event.text === 'string'
    && /^You move right into the floating eye\.$/i.test(event.text));
  if (!event) return absent('no-action-local-bump');
  return {
    kind: 'fresh-eye-bump', reason: 'action-local-heard',
    evidence: {
      sessionId: frame.sessionId, revision: frame.revision,
      ...(mcp ? { callId } : { requestId: frame.requestId }),
      method, action, status: outcome.status, turnsElapsed: outcome.turnsElapsed,
      text: event.text, source: 'events.heard',
    },
  };
}
