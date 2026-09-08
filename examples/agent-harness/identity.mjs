import { parseArgs } from 'node:util';

/** Harness policy operations, not an alternative engine command catalog. */
export const GUARD_OPERATIONS = Object.freeze(['attack', 'kick']);

export class GuardIdentityError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'GuardIdentityError';
    this.code = code;
  }
}

function requireThat(condition, code, message) {
  if (!condition) throw new GuardIdentityError(code, message);
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const token = value => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
const revision = value => Number.isSafeInteger(value) && value >= 0;

function validateRequest(request) {
  requireThat(object(request), 'invalid_request', 'A guard request is required.');
  requireThat(token(request.runId), 'invalid_request', 'RUN must be an explicit run token (letters, digits, underscore or hyphen).');
  requireThat(GUARD_OPERATIONS.includes(request.operation), 'invalid_operation', 'Operation must be attack or kick.');
  requireThat(object(request.target) && revision(request.target.x) && revision(request.target.y),
    'invalid_target', 'Target must contain nonnegative safe integer x and y coordinates.');
  requireThat(typeof request.expectedSessionId === 'string' && request.expectedSessionId.length > 0,
    'invalid_request', 'An expected nonempty opaque session ID is required.');
  requireThat(revision(request.expectedRevision), 'invalid_request', 'An expected nonnegative safe integer revision is required.');
}

/**
 * Parse RUN OPERATION X Y --session-id ID --revision N (no implicit defaults).
 * The supervisor owns the runnable entrypoint and must treat thrown errors as
 * refusal, never as permission to dispatch. No files or gameplay are accessed.
 */
export function parseGuardArgs(argv) {
  requireThat(Array.isArray(argv) && argv.every(value => typeof value === 'string'),
    'invalid_arguments', 'Arguments must be an array of strings.');
  let parsed;
  try {
    parsed = parseArgs({ args: argv, strict: true, allowPositionals: true, tokens: true,
      options: { 'session-id': { type: 'string' }, revision: { type: 'string' } } });
  } catch (cause) {
    throw new GuardIdentityError('invalid_arguments', cause.message, { cause });
  }
  const options = parsed.tokens.filter(entry => entry.kind === 'option');
  requireThat(new Set(options.map(entry => entry.name)).size === options.length,
    'invalid_arguments', 'Options must not be repeated.');
  requireThat(parsed.positionals.length === 4, 'invalid_arguments',
    'Usage: RUN OPERATION X Y --session-id ID --revision N');
  const [runId, operation, x, y] = parsed.positionals;
  const integer = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)
    ? Number(value) : NaN;
  const request = { runId, operation, target: { x: integer(x), y: integer(y) },
    expectedSessionId: parsed.values['session-id'], expectedRevision: integer(parsed.values.revision) };
  validateRequest(request);
  return request;
}

function validateIdentity(request, identity, source) {
  requireThat(object(identity), 'missing_identity', `${source} identity is required.`);
  requireThat(identity.runId === request.runId, 'run_mismatch', `${source} belongs to a different run.`);
  requireThat(identity.sessionId === request.expectedSessionId, 'session_mismatch', `${source} belongs to a different session.`);
  requireThat(revision(identity.revision), 'missing_identity', `${source} revision is required.`);
  requireThat(identity.revision === request.expectedRevision, 'stale_revision', `${source} revision does not match the expected revision.`);
  requireThat(identity.ended === false && identity.end === null, 'inactive_state', `${source} must explicitly identify a nonterminal session.`);
}

/**
 * Validate a selected run's {runId, snapshot} against an independently supplied
 * currentIdentity {runId, sessionId, revision, ended, end}. runId is harness
 * metadata; snapshot is a reconstructed public semantic response, including
 * observation, decision, ended and end. Never stamp the requested identity onto
 * an unlabelled or cached response to make it pass these checks.
 *
 * Returns the snapshot for the caller's perceived-threat policy. This is only
 * an identity check, not a safety judgment, receipt or authorization to retry.
 * Freshness is relative to currentIdentity: callers must obtain that identity
 * from the current run owner, not derive it from the cached snapshot. The final
 * input still needs engine revision checks and exact request/decision receipts;
 * this function cannot prevent another actor changing the game after the read.
 */
export function validateGuardIdentity(request, envelope, currentIdentity) {
  validateRequest(request);
  validateIdentity(request, currentIdentity, 'Current');
  requireThat(object(envelope) && object(envelope.snapshot), 'missing_snapshot', 'The selected run has no snapshot.');
  const { snapshot } = envelope;
  validateIdentity(request, { ...snapshot, runId: envelope.runId }, 'Snapshot');
  requireThat(snapshot.version === 1 && object(snapshot.observation), 'invalid_snapshot', 'A public v1 observation snapshot is required.');
  requireThat(!snapshot.error && snapshot.historical !== true && snapshot.outcome?.status !== 'unknown',
    'uncertain_snapshot', 'An error, historical receipt or uncertain outcome cannot establish current guard state.');
  requireThat(snapshot.update === undefined || snapshot.update?.kind === 'snapshot',
    'invalid_snapshot', 'Reconstruct observation deltas before checking guard identity.');
  requireThat(snapshot.decision === null, 'standing_decision', 'Melee requires an explicit no-decision snapshot; answer standing decisions separately.');
  return snapshot;
}

/**
 * Inject readSnapshot(runId) -> {runId, snapshot} and
 * readCurrentIdentity(runId) -> {runId, sessionId, revision, ended, end}.
 * Readers must reject missing/corrupt state, never fall back to another run.
 * Current identity is read after the snapshot to catch intervening changes.
 * Hold the authoritative client's writer lock across these reads, the guard
 * policy and dispatch; identity validation alone does not acquire that lock.
 * No ambient run, filesystem layout, eye policy or dispatch is owned here.
 */
export async function loadGuardSnapshot(request, { readSnapshot, readCurrentIdentity } = {}) {
  validateRequest(request);
  requireThat(typeof readSnapshot === 'function' && typeof readCurrentIdentity === 'function',
    'missing_reader', 'Both snapshot and current identity readers are required.');
  // Copy caller-owned input before awaiting readers; rotation must not silently
  // retarget a request that is already being checked.
  const expected = { ...request, target: { ...request.target } };
  const envelope = await readSnapshot(expected.runId);
  const current = await readCurrentIdentity(expected.runId);
  return validateGuardIdentity(expected, envelope, current);
}
