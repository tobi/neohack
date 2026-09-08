/**
 * Run-scoped orchestration policy over public semantic snapshots only.
 *
 * Construct with an explicitly selected sessionId. Feed current, reconstructed
 * snapshots to acceptSnapshot (never historical receipts). Serialize requests:
 * assertAllowed immediately before sending, then await acceptSnapshot before
 * sending again. Register cancellation callbacks for ALL scheduled play/poll
 * jobs; callbacks must also gate at dispatch in case cancellation races delivery.
 * This module cannot recall a request already sent to the engine.
 *
 * status() is JSON serializable; a CLI prints it alongside the response and sets
 * process.exitCode to its exitCode. Persist status and the authoritative snapshot
 * before exiting; this helper is memory-only. On restart ingest the saved
 * snapshot and call disconnect() if saved status was disconnected, before
 * registering jobs or dispatching input. Never initialize play from a cached
 * alive snapshot after an unresolved transport loss.
 * It neither creates sessions nor resumes engines. After a supported explicit
 * same-session resume succeeds, pass its current snapshot to resume(). Transport
 * loss calls disconnect(); it is not evidence of death or permission to retry.
 * The disconnected state also covers explicit uncertainty/recovery diagnostics;
 * ended/end retain their authoritative values. canPlay is only a lifecycle
 * gate: the client must still enforce pending decisions, receipts and ownership.
 */
export const LIFECYCLE_EXIT_CODES = Object.freeze({
  alive: 0,
  terminal: 20,
  disconnected: 21,
  unknown: 22,
});

export class LifecycleBlockedError extends Error {
  constructor(operation, status) {
    super(`Cannot ${operation}: session ${status.sessionId} is ${status.state}`);
    this.name = 'LifecycleBlockedError';
    this.code = 'lifecycleBlocked';
    this.status = status;
    this.exitCode = status.exitCode || 1;
  }
}

const endKinds = new Set([
  'death', 'ascended', 'escaped', 'quit', 'disconnected', 'engineError', 'unknown',
]);
const operations = new Set(['play', 'poll', 'observe', 'export', 'resume']);
const blockedGate = snapshot => [snapshot.inputGate, snapshot.observation?.neighborhood?.inputGate]
  .some(gate => gate !== undefined && !['ready', 'decision'].includes(gate?.state));
const requiresRecovery = snapshot => blockedGate(snapshot)
  || Boolean(snapshot.error)
  || snapshot.outcome?.status === 'unknown'
  || [snapshot.storage, snapshot.recording]
    .some(diagnostic => diagnostic != null && (diagnostic.status !== 'ok' || diagnostic.requiresResume === true));

export function createRunLifecycle({ sessionId } = {}) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new TypeError('An explicit sessionId is required');
  }
  let state = 'unknown';
  let revision = null;
  let ended = null;
  let end = null;
  const jobs = new Set();

  function status() {
    return {
      sessionId, state, revision, ended, end: end === null ? null : { ...end },
      canPlay: state === 'alive',
      exitCode: LIFECYCLE_EXIT_CODES[state],
    };
  }

  function validate(snapshot) {
    if (!snapshot || snapshot.sessionId !== sessionId) {
      throw new TypeError('Snapshot must belong to this sessionId');
    }
    if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0
        || typeof snapshot.ended !== 'boolean'
        || (snapshot.end !== null && (!snapshot.end || !endKinds.has(snapshot.end.kind)))
        || (!snapshot.ended && snapshot.end !== null)) {
      throw new TypeError('Expected authoritative revision, ended and end fields');
    }
  }

  async function cancelJobs() {
    const pending = [...jobs];
    jobs.clear();
    // Close the gate before invoking even the first callback; one failed cancel
    // must not prevent the remaining run-specific jobs from being canceled.
    const results = await Promise.allSettled(pending.map(async cancel => cancel(status())));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Run stopped, but job cancellation failed');
    return status();
  }

  async function acceptSnapshot(snapshot) {
    validate(snapshot);
    if (revision !== null && snapshot.revision < revision) return status();
    // Terminal is irreversible. A cached live frame, including at the same
    // revision, never opens it. Disconnection needs explicit resume below.
    if (state === 'terminal') return status();
    if (state === 'disconnected' && !snapshot.ended) return status();
    revision = snapshot.revision;
    ended = snapshot.ended;
    end = snapshot.end === null ? null : { ...snapshot.end };
    state = ended ? (end?.kind === 'disconnected' ? 'disconnected' : 'terminal')
      : requiresRecovery(snapshot) ? 'disconnected' : 'alive';
    return state === 'alive' ? status() : cancelJobs();
  }

  function assertAllowed(operation, { deliberate = false } = {}) {
    if (!operations.has(operation)) throw new TypeError(`Unknown lifecycle operation: ${operation}`);
    const allowed = operation === 'resume'
      ? deliberate === true && (state === 'disconnected' || state === 'unknown')
      : state === 'alive' || (deliberate === true && (operation === 'observe' || operation === 'export'));
    if (!allowed) throw new LifecycleBlockedError(operation, status());
    return status();
  }

  function registerPlayJob(cancel) {
    if (typeof cancel !== 'function') throw new TypeError('Expected a job cancellation callback');
    assertAllowed('poll');
    // Unique registrations even if the caller reuses a cancellation function.
    const callback = current => cancel(current);
    jobs.add(callback);
    return () => jobs.delete(callback);
  }

  async function disconnect() {
    if (state !== 'terminal') state = 'disconnected';
    return cancelJobs();
  }

  async function resume(snapshot, { explicit = false } = {}) {
    assertAllowed('resume', { deliberate: explicit });
    validate(snapshot);
    if (requiresRecovery(snapshot) || (revision !== null && snapshot.revision < revision)) {
      throw new TypeError('Resume requires a successful current same-session snapshot');
    }
    // Only this path can reopen a disconnected run. It does not recreate jobs;
    // the orchestrator must deliberately schedule any further play.
    state = 'unknown';
    return acceptSnapshot(snapshot);
  }

  return Object.freeze({ status, acceptSnapshot, assertAllowed, registerPlayJob, disconnect, resume });
}
