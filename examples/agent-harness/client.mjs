import { mkdir, open, readFile, rename, unlink, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const settled = new Set(['completed', 'needsChoice', 'blocked', 'cancelled', 'interrupted']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const revision = value => Number.isSafeInteger(value) && value >= 0;
const clone = value => JSON.parse(JSON.stringify(value));
function immutable(value) {
  if (object(value) || Array.isArray(value)) {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
function fail(code, message) { return Object.assign(new Error(message), { code }); }

/** Unwrap public responses only. Inject the library's CompactObservationReader
 * through decodeReply for deltas; this module never reconstructs perception. */
export function decodeSnapshotReply(raw) {
  if (raw?.error || raw?.isError || raw?.result?.isError)
    throw fail('REPLY_ERROR', 'The request returned an error.');
  return raw?.result?.structuredContent ?? raw?.structuredContent ?? raw;
}

async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Durable replacement on a local filesystem supporting fsync and atomic rename.
 * A crash leaves either complete file, never a partially overwritten snapshot. */
async function atomicJSON(path, value, checkpoint) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally { await handle.close(); }
  try {
    await checkpoint?.({ phase: 'temporary-synced', path, value });
    await rename(temporary, path);
    await syncDirectory(resolve(path, '..'));
    await checkpoint?.({ phase: 'committed', path, value });
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

/**
 * One bound run, dependency-free Node ESM. All writers of a run must use the
 * SAME runDir on a local filesystem. Another process holding .client-owner
 * gets RUN_BUSY; there is no unsafe clock/PID-based lease stealing. After a
 * process crash an operator must establish that the owner is stopped before
 * removing that directory. Keep state.json and receipts intact for recovery.
 *
 * send({name,arguments}, {snapshot,reservationId}) returns a raw semantic/MCP reply. High MCP
 * owns request IDs/revisions; arguments.expectedRevision is checked locally and
 * removed before send. send must durably reserve its exact operation before
 * engine input. reservationId is a local correlation token, never a game input
 * ID. Bind it to the transport's journal reservation. recoverExact(call,
 * {snapshot,reservationId}) must recover that SAME reserved
 * operation, never dispatch a new action; absent exact evidence it must throw.
 * The callback is the injected bridge/dispatcher recovery boundary, not a retry
 * policy. Successful recovery always requests a fresh observe.
 *
 * execute(call,{preflight}), call(call), and play(name,args) share ownership.
 * preflight(envelope,call) runs inside it before reservation/send and MUST throw
 * to block. A configured preflight applies to ordinary requests through every
 * entrypoint. Explicit observe/recover perform only observation/exact recovery.
 * Never call client methods recursively from preflight; it already holds the
 * run lock. Use the supplied immutable envelope for all guard decisions.
 *
 * readSnapshot() returns {sessionId,status,revision,snapshot,pendingRequest,...}.
 * Only status=current is usable for preflight. Other states retain the last
 * perceived snapshot as explicitly stale evidence. Receipts are immutable
 * individual JSON files, separate from the current snapshot. No tools/list,
 * session creation, resumption or session switching occurs here.
 * checkpoint is an optional awaited filesystem fault-injection hook for tests.
 */
export function createSnapshotClient({ runDir, sessionId, send, recoverExact,
  decodeReply = decodeSnapshotReply, preflight, checkpoint } = {}) {
  if (typeof runDir !== 'string' || !runDir || typeof sessionId !== 'string' || !sessionId
    || typeof send !== 'function') throw new TypeError('runDir, sessionId and send are required.');
  const directory = resolve(runDir), statePath = join(directory, 'state.json');
  const lockPath = join(directory, '.client-owner'), receiptsPath = join(directory, 'receipts');
  let tail = Promise.resolve();

  async function readState() {
    let state;
    try { state = JSON.parse(await readFile(statePath, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { version: 1, sessionId, status: 'empty', revision: null,
        snapshot: null, pendingRequest: null, pendingKind: null, pendingId: null };
    }
    if (state.sessionId !== sessionId) throw fail('WRONG_SESSION', 'Snapshot belongs to another session.');
    if (state.version !== 1 || !['empty', 'current', 'uncertain', 'error', 'needs-observation'].includes(state.status)
      || !(state.revision === null || revision(state.revision))
      || !Object.hasOwn(state, 'pendingRequest') || !Object.hasOwn(state, 'snapshot')
      || (state.pendingRequest && (typeof state.pendingId !== 'string' || !state.pendingId))
      || (state.pendingRequest && state.pendingRequest.arguments?.sessionId !== sessionId)
      || (state.snapshot && (state.snapshot.sessionId !== sessionId || !revision(state.snapshot.revision)
        || state.snapshot.revision > state.revision))
      || (state.status === 'current' && (!state.snapshot || state.pendingRequest
        || state.snapshot.revision !== state.revision)))
      throw fail('CORRUPT_STATE', 'Snapshot envelope is inconsistent; preserve it for inspection.');
    return state;
  }

  function normalized(call) {
    if (!object(call) || typeof call.name !== 'string' || !call.name || !object(call.arguments ?? {}))
      throw new TypeError('Expected {name, arguments}.');
    const args = clone(call.arguments ?? {});
    if (Object.hasOwn(args, 'sessionId') && args.sessionId !== sessionId)
      throw fail('WRONG_SESSION', 'Arguments cannot override the bound session.');
    return { name: call.name, arguments: { ...args, sessionId } };
  }
  function requireCurrent(state) {
    if (state.status !== 'current' || state.pendingRequest)
      throw fail('STALE_SNAPSHOT', `Snapshot is ${state.status}; observe or recover explicitly.`);
  }

  async function owned(callback) {
    await mkdir(directory, { recursive: true });
    try { await mkdir(lockPath); }
    catch (error) {
      if (error.code === 'EEXIST') throw fail('RUN_BUSY', 'Run has an exclusive owner; crash ownership requires inspection.');
      throw error;
    }
    let active = true;
    let storageHealthy = true;
    async function persist(path, value) {
      try { await atomicJSON(path, value, checkpoint); }
      catch (error) { storageHealthy = false; throw error; }
    }
    const save = state => persist(statePath, state);
    const assertOwned = () => { if (!active) throw fail('OWNERSHIP_ENDED', 'Run transaction has ended.'); };
    async function readSnapshot({ requireCurrent: current = true } = {}) {
      assertOwned();
      const state = await readState();
      if (current) requireCurrent(state);
      return immutable(state);
    }

    async function receive(call, state, transport, kind) {
      // Invalidation is durable BEFORE transport invocation, even for observes.
      const pending = { ...state, status: 'uncertain', reason: 'in-flight',
        pendingRequest: call, pendingKind: kind,
        pendingId: kind === 'recovery' ? state.pendingId : randomUUID() };
      await save(pending);
      let raw;
      try { raw = await transport(immutable(clone(call)), immutable({
        snapshot: clone(state.snapshot), reservationId: pending.pendingId })); }
      catch (error) {
        await save({ ...pending, reason: 'transport-uncertain' });
        throw error;
      }
      // Preserve every reply before inspecting it or replacing the snapshot.
      await mkdir(receiptsPath, { recursive: true });
      await persist(join(receiptsPath, `${randomUUID()}.json`), {
        sessionId, kind, reservationId: pending.pendingId, call, raw });
      let response;
      try {
        if (raw?.error || raw?.isError || raw?.result?.isError)
          throw fail('REPLY_ERROR', 'The request returned an error.');
        response = clone(await decodeReply(raw));
        if (!object(response)) throw fail('INVALID_REPLY', 'Missing semantic reply.');
        if (response.version !== 1) throw fail('INVALID_REPLY', 'Unsupported semantic response version.');
        if (response.error) throw fail('REPLY_ERROR', 'The semantic reply returned an error.');
        if (response.sessionId !== sessionId) throw fail('WRONG_SESSION', 'Reply belongs to another session.');
        if (call.arguments.requestId !== undefined && response.requestId !== call.arguments.requestId)
          throw fail('WRONG_RECEIPT', 'Reply request identity does not match.');
        if (response.update?.kind === 'delta') throw fail('UNRESOLVED_DELTA', 'Inject the shared compact reader before accepting deltas.');
        if ((response.outcome && !settled.has(response.outcome.status))
          || [response.storage, response.recording].some(value => value && value.status !== 'ok'))
          throw fail('UNCERTAIN_REPLY', 'Execution or durability remains uncertain.');
        const gates = [response.inputGate, response.observation?.neighborhood?.inputGate];
        if (response.diagnostics?.requiresResume === true)
          throw fail('RESUME_REQUIRED', 'The owning runtime requires explicit resume; this client cannot resume it.');
        if (gates.some(gate => gate?.state === 'recoveryRequired')
          || response.observation?.neighborhood?.reason === 'recoveryRequired')
          throw fail('RECOVERY_REQUIRED', 'The public input gate requires exact recovery.');
        if (gates.some(gate => gate && !['ready', 'decision', 'ended'].includes(gate.state))
          || response.observation?.neighborhood?.status === 'unavailable')
          throw fail('UNCERTAIN_REPLY', 'The public input gate is unavailable.');
        if (response.observation && (!revision(response.revision) || !revision(response.observation.turn)
          || !object(response.observation.location) || typeof response.observation.location.id !== 'string'
          || !settled.has(response.outcome?.status) || typeof response.ended !== 'boolean'
          || !(response.decision === null || (object(response.decision) && typeof response.decision.id === 'string'))
          || !(response.end === null || object(response.end)) || !Array.isArray(response.events)))
          throw fail('INVALID_REPLY', 'Incomplete semantic snapshot.');
        if (kind === 'recovery' && !settled.has(response.outcome?.status))
          throw fail('UNCERTAIN_REPLY', 'Exact recovery has not returned a settled receipt.');
        if (!response.observation && !settled.has(response.outcome?.status)
          && !['actions', 'route', 'navigation', 'lore'].includes(response.kind))
          throw fail('INVALID_REPLY', 'Reply does not establish a settled outcome or a public query.');
        if (response.observation && response.historical !== true && call.name !== 'receipt' && kind !== 'recovery'
          && response.revision >= (state.revision ?? 0) && state.snapshot?.ended
          && (!response.ended || !response.end))
          throw fail(state.snapshot.end?.kind === 'disconnected' ? 'RESUME_REQUIRED' : 'TERMINAL_REGRESSION',
            'A terminal snapshot cannot become live through this client.');
      } catch (error) {
        await save({ ...pending, status: error.code === 'REPLY_ERROR' ? 'error' : 'uncertain',
          pendingKind: error.code === 'RECOVERY_REQUIRED' ? 'recovery' : pending.pendingKind,
          reason: error.code ?? 'invalid-reply' });
        throw error;
      }
      const old = revision(response.revision) && state.revision !== null && response.revision < state.revision;
      const historical = response.historical === true || call.name === 'receipt' || kind === 'recovery';
      const current = !!response.observation && !old && !historical;
      const next = { ...pending, status: current ? 'current' : 'needs-observation',
        reason: current ? null : historical ? 'historical-receipt' : old ? 'older-revision' : 'no-observation',
        revision: revision(response.revision) ? Math.max(state.revision ?? 0, response.revision) : state.revision,
        snapshot: current ? response : state.snapshot, pendingRequest: null, pendingKind: null, pendingId: null };
      await save(next);
      return { reply: raw, response, state: immutable(clone(next)) };
    }

    async function execute(call, { preflight: check } = {}) {
      assertOwned();
      call = normalized(call);
      const state = await readState();
      if (state.reason === 'RESUME_REQUIRED')
        throw fail('RESUME_REQUIRED', 'Explicit runtime ownership/resume is required outside this client.');
      const observing = call.name === "observe";
      if (state.pendingRequest && state.pendingKind !== 'observe')
        throw fail('RECOVERY_REQUIRED', 'Exact recovery must settle pending execution before observation or new input.');
      if (!observing) {
        requireCurrent(state);
        if (state.snapshot.ended || state.snapshot.end)
          throw fail('TERMINAL_STATE', 'Terminal state requires owner lifecycle handling, not another action.');
      }
      if (Object.hasOwn(call.arguments, 'expectedRevision')) {
        if (call.arguments.expectedRevision !== state.revision)
          throw fail('STALE_REVISION', 'Caller revision does not match the current snapshot.');
        delete call.arguments.expectedRevision;
      }
      if (!observing) {
        const envelope = immutable(clone(state)), request = immutable(clone(call));
        await preflight?.(envelope, request);
        await check?.(envelope, request);
      }
      assertOwned();
      return receive(call, state, send, observing ? 'observe' : 'request');
    }

    async function recover() {
      assertOwned();
      const state = await readState();
      if (state.reason === 'RESUME_REQUIRED')
        throw fail('RESUME_REQUIRED', 'Exact receipts do not perform the required runtime resume.');
      if (!state.pendingRequest || state.pendingKind === 'observe' || typeof recoverExact !== 'function')
        throw fail('RECOVERY_UNAVAILABLE', 'No pending exact operation or no exact recovery provider.');
      const recovered = await receive(state.pendingRequest, state, recoverExact, 'recovery');
      const observed = await execute({ name: "observe", arguments: {} });
      if (observed.state.status !== 'current')
        throw fail('STALE_SNAPSHOT', 'Recovery settled, but current observation is unavailable.');
      return { recovered, observed, state: observed.state };
    }
    const owner = Object.freeze({ assertOwned, readSnapshot, send: execute, recover,
      observe: () => execute({ name: "observe", arguments: {} }) });
    try { return await callback(owner); }
    // A failed fsync/rename is not proof of durable state, even if a current
    // file happens to be visible. Retain ownership for operator inspection.
    finally { active = false; if (storageHealthy) await rmdir(lockPath); }
  }
  function withRunWriter(callback) {
    const result = tail.then(() => owned(callback));
    tail = result.catch(() => {});
    return result;
  }
  function execute(call, options) {
    // Capture intent before queueing; later caller mutations cannot change it.
    const request = normalized(call);
    return withRunWriter(owner => owner.send(request, options));
  }
  return Object.freeze({ sessionId, execute, call: execute,
    play: (name, args = {}, options) => execute({ name, arguments: args }, options),
    readSnapshot: options => withRunWriter(owner => owner.readSnapshot(options)),
    observe: () => withRunWriter(owner => owner.observe()),
    recover: () => withRunWriter(owner => owner.recover()) });
}
