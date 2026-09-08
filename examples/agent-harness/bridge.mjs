import { spawn } from 'node:child_process';
import { openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

export class BridgeRequestError extends Error {
  constructor(reason, record, durability = 'recorded') {
    super(`Bridge request ${record.requestId}: ${reason}`);
    this.name = 'BridgeRequestError';
    this.reason = reason;
    this.classification = record.attempted ? 'execution_uncertain' : 'not_sent';
    this.record = record;
    this.durability = durability;
  }
  toJSON() {
    return { classification: this.classification, reason: this.reason,
      record: this.record, durability: this.durability, retry: false };
  }
}

// A new journal per bridge lifetime: never truncate/reuse historical evidence.
// append returns only after fsync. Injected journals must provide the same
// synchronous durability contract: {path, append(record), close()}.
function fileJournal(path) {
  path = resolve(path);
  const fd = openSync(path, 'wx', 0o600);
  try {
    fsyncSync(fd);
    const dir = openSync(dirname(path), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } catch (error) { closeSync(fd); throw error; }
  return {
    path,
    append(record) {
      const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
      fsyncSync(fd);
    },
    close() { closeSync(fd); },
  };
}

/** Supervise one MCP stdio process; no game semantics, retries or receipt repair.
 * rpc(fullJsonRpcRequest, {signal, timeoutMs, reservationId}) returns the exact
 * JSON response. Optional reservationId is a caller-persisted opaque local ID:
 * it links journal records only, never changes the wire request, and cannot be
 * reused to dispatch another input. Recovery reads records by this identity.
 * notify(fullJsonRpcNotification) records transport delivery only.
 * handleHttp accepts a POST containing the same JSON-RPC request (no player map).
 * close(reason) is idempotent and bounded; callers must await it before exiting.
 * POSIX descendants must remain in our process group. Windows uses child-only
 * ownership; inject signalChild/ownedAlive for a platform job-object supervisor.
 * A timeout/disconnect stops admission; late responses remain in the journal.
 * A durable dispatch with no settled response is uncertain after a crash, too.
 * Restart/recovery requires an explicit caller decision through public receipts.
 */
export function createBridge({ command, args = [], cwd, env, journalPath, journal,
  timeoutMs = 30_000, closeGraceMs = 500, maxBodyBytes = 1_048_576,
  spawnChild = spawn, platform = process.platform, signalChild, ownedAlive } = {}) {
  for (const [name, value] of Object.entries({ timeoutMs, closeGraceMs, maxBodyBytes })) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
      throw new TypeError(`${name} must be a positive bounded integer`);
  }
  journal ??= fileJournal(journalPath);
  const pending = new Map();
  const requests = new Map();
  const reservations = new Set();
  let sequence = 0, unavailable, child, childClosed = false, closePromise;
  let journalFailed = false, journalClosed = false, failing = false;
  const grouped = platform !== 'win32';
  function log(kind, fields = {}) {
    if (journalClosed) return;
    try {
      journal.append({ sequence: ++sequence, at: new Date().toISOString(), kind, ...fields });
    } catch (error) { journalFailed = true; throw error; }
  }
  function settle(entry, reason, response) {
    if (!pending.delete(entry.key)) return;
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener('abort', entry.abort);
    if (!entry.notification) requests.set(entry.key, { key: entry.key, sequence: entry.sequence,
      reservationId: entry.reservationId });
    const record = { journal: journal.path, requestSequence: entry.sequence,
      requestId: entry.request.id ?? null, reservationId: entry.reservationId,
      attempted: entry.attempted };
    try {
      log('settled', { ...record, classification: reason
        ? (entry.attempted ? 'execution_uncertain' : 'not_sent')
        : (entry.notification ? 'notification_written' : 'response'), reason });
    } catch { reason = 'journal_failure'; fail(reason); }
    if (reason) entry.reject(new BridgeRequestError(reason, record,
      journalFailed ? 'failed' : 'recorded'));
    else entry.resolve(response);
  }
  function fail(reason) {
    unavailable ??= reason;
    if (failing) return;
    failing = true;
    for (const entry of pending.values()) settle(entry, reason);
    failing = false;
  }
  try {
    child = spawnChild(command, args, { cwd, env, detached: grouped,
      stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    // Install error listeners before parsing output or exposing the bridge.
    child.on('error', error => {
      // A failed spawn has no process and cannot have executed queued writes.
      if (!child.pid) for (const entry of pending.values()) entry.attempted = false;
      fail(`child_error:${error.code ?? error.message}`);
    });
    child.stdin.on('error', error => fail(`stdin_error:${error.code ?? error.message}`));
    child.stdout.on('error', error => fail(`stdout_error:${error.code ?? error.message}`));
    child.stderr.on('error', error => fail(`stderr_error:${error.code ?? error.message}`));
    child.on('exit', (code, signal) => fail(`child_exit:${code ?? signal}`));
    child.on('close', () => { childClosed = true; fail('child_closed'); });
    child.stdin.on('close', () => fail('stdin_closed'));
    const lines = createInterface({ input: child.stdout });
    lines.on('line', raw => {
      let message;
      try { message = JSON.parse(raw); } catch {
        try { log('invalid_stdout', { raw }); } catch { fail('journal_failure'); }
        fail('invalid_stdout');
        return;
      }
      const entry = requests.get(message?.id);
      try { log('response', { message, requestSequence: entry?.sequence ?? null,
        reservationId: entry?.reservationId ?? null,
        late: Boolean(entry && !pending.has(entry.key)) }); }
      catch { fail('journal_failure'); return; }
      if (entry && pending.has(entry.key)) {
        const isResponse = message.jsonrpc === '2.0' && !Object.hasOwn(message, 'method') &&
          Object.hasOwn(message, 'result') !== Object.hasOwn(message, 'error');
        if (!isResponse) fail('invalid_response');
        else settle(pending.get(entry.key), null, message);
      }
    });
    lines.on('close', () => fail('stdout_closed'));
    child.stdout.on('close', () => fail('stdout_closed'));
    // Drain stderr so a full pipe cannot wedge MCP. This is diagnostic output.
    child.stderr.on('data', bytes => {
      try { log('stderr', { text: bytes.toString() }); } catch { fail('journal_failure'); }
    });
  } catch (error) { unavailable = `spawn_error:${error.code ?? error.message}`; }

  const sendSignal = signalChild ?? ((proc, signal) => {
    if (grouped && proc.pid) process.kill(-proc.pid, signal);
    else if (!childClosed) proc.kill(signal);
  });
  const alive = ownedAlive ?? (proc => {
    if (!grouped || !proc?.pid) return Boolean(proc && !childClosed);
    try { process.kill(-proc.pid, 0); return true; }
    catch (error) { return error.code !== 'ESRCH'; }
  });

  function dispatch(input, { signal, timeoutMs: deadline = timeoutMs,
    reservationId = null } = {}, notification = false) {
    return new Promise((resolveRequest, reject) => {
      // Snapshot caller data; preserve semantic request IDs and decision tokens.
      const request = JSON.parse(JSON.stringify(input));
      if (request?.jsonrpc !== '2.0' || typeof request.method !== 'string' ||
          (notification ? Object.hasOwn(request, 'id') :
            !(typeof request.id === 'string' || Number.isSafeInteger(request.id))))
        throw new TypeError('Expected a JSON-RPC 2.0 request with a string/integer id (or notification without id)');
      if (journalClosed) throw new BridgeRequestError('bridge_closed', {
        journal: journal.path, requestSequence: null, requestId: request.id ?? null,
        reservationId, attempted: false,
      }, 'not_recorded');
      if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 2_147_483_647)
        throw new TypeError('timeoutMs must be a positive bounded integer');
      if (!notification && requests.has(request.id))
        throw new Error('Request id already used; bridge never retries requests');
      if (reservationId !== null && (typeof reservationId !== 'string' || !reservationId.length))
        throw new TypeError('reservationId must be a nonempty string');
      if (reservationId !== null && reservations.has(reservationId))
        throw new Error('Reservation id already used; recover its exact record instead of dispatching again');
      const key = notification ? Symbol('notification') : request.id;
      const entry = { request, key, notification, reservationId, sequence: sequence + 1, attempted: false,
        resolve: resolveRequest, reject, signal };
      pending.set(key, entry);
      if (!notification) requests.set(key, entry);
      if (reservationId !== null) reservations.add(reservationId);
      try { log('request', { message: request, reservationId }); }
      catch { fail('journal_failure'); return; }
      if (unavailable || signal?.aborted) {
        settle(entry, unavailable ?? 'connection_lost'); return;
      }
      entry.abort = () => fail('connection_lost');
      signal?.addEventListener('abort', entry.abort, { once: true });
      entry.timer = setTimeout(() => fail('timeout'), deadline);
      // Record intent before write: even a partial write is execution-uncertain.
      try { log('dispatch', { requestSequence: entry.sequence, reservationId }); }
      catch { fail('journal_failure'); return; }
      entry.attempted = true;
      try {
        child.stdin.write(`${JSON.stringify(request)}\n`, error => {
          if (error) fail(`stdin_error:${error.code ?? error.message}`);
          else if (notification) settle(entry, null, { notificationWritten: true });
        });
      } catch (error) { fail(`stdin_error:${error.code ?? error.message}`); }
    });
  }

  async function handleHttp(req, res) {
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableFinished) controller.abort(); };
    req.on('aborted', disconnect);
    req.on('error', disconnect);
    res.on('close', disconnect);
    res.on('error', disconnect);
    try {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBodyBytes) { res.writeHead(413); res.end(); return; }
        chunks.push(chunk);
      }
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const response = await dispatch(request, { signal: controller.signal });
      if (!res.destroyed) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(response));
      }
    } catch (error) {
      if (!res.destroyed) {
        res.writeHead(error instanceof BridgeRequestError ? 503 : 400,
          { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof BridgeRequestError
          ? error.toJSON() : { classification: 'not_sent', reason: error.message, retry: false } }));
      }
    } finally {
      req.off('aborted', disconnect); req.off('error', disconnect);
      res.off('close', disconnect); res.off('error', disconnect);
    }
  }

  function close(reason = 'shutdown') {
    if (closePromise) return closePromise;
    fail(reason);
    closePromise = (async () => {
      const errors = [];
      const signal = value => {
        if (!child) return;
        try { sendSignal(child, value); }
        catch (error) { if (error.code !== 'ESRCH') errors.push(error.message); }
      };
      const wait = async () => {
        const until = Date.now() + closeGraceMs;
        while ((!childClosed || alive(child)) && child && Date.now() < until)
          await delay(Math.min(20, Math.max(1, until - Date.now())));
      };
      child?.stdin?.end();
      signal('SIGTERM');
      await wait();
      if (child && (!childClosed || alive(child))) { signal('SIGKILL'); await wait(); }
      const result = { childClosed: !child || childClosed, ownedProcessesRemaining: alive(child),
        ownership: grouped ? 'process_group' : 'child_only', errors };
      try { log('shutdown', result); } catch { result.durability = 'failed'; }
      // Bound local handles even when an escaped descendant holds a pipe open.
      child?.stdin?.destroy(); child?.stdout?.destroy(); child?.stderr?.destroy();
      journalClosed = true;
      try { journal.close(); } catch (error) { result.durability = 'failed'; result.errors.push(error.message); }
      return result;
    })();
    return closePromise;
  }
  return { rpc: dispatch, notify: request => dispatch(request, {}, true), handleHttp, close,
    get pendingCount() { return pending.size; } };
}
