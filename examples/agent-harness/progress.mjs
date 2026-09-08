/**
 * Navigation retry accounting, not a movement policy or transport.
 * Keep one budget per run across helper invocations. An intent is a stable key
 * for one policy objective (do not include request IDs/revisions). Resolve a
 * direction to an absolute target before begin(). maxAttempts bounds the whole
 * intent even when movement/obstructions oscillate; it never resets implicitly.
 *
 * begin({intent, snapshot, target, candidates?}) reserves an input BEFORE sending.
 * If allowed, settle(token, {status: 'ok'|'error'|'unknown', snapshot}) exactly
 * once after receipt validation/reconstruction by the transport. 'ok' must mean
 * a known, exact response, not just HTTP success. Exceptions/missing replies
 * must settle as unknown. A pending reservation blocks all subsequent inputs.
 * Errors/uncertainty latch the budget closed; reconcile outside this module.
 * Raw deltas, historical receipts, and non-ok storage/recording diagnostics
 * latch uncertainty even if the caller classifies the response as 'ok'.
 *
 * Snapshots are public response-shaped objects with sessionId and observation
 * (location.id, you, world; optional neighborhood). This helper neither obtains
 * receipts nor answers decisions. `allowed` only means budget remains: the
 * caller must still apply decision, health, hunger and other stop policies.
 * Alternatives are caller-proposed perceived targets, never selected actions
 * or a safety guarantee. In particular, floor does not authorize force stepping
 * through an occupant/hazard. No summary, glyph identity, turn, or revision is
 * used as evidence of progress. Revealed terrain must concern the attempted
 * target; unrelated map changes never count. Revisions only validate
 * neighborhood freshness.
 */

const point = p => Number.isSafeInteger(p?.x) && Number.isSafeInteger(p?.y);
const key = p => `${p.x},${p.y}`;
const pick = (object, keys) => Object.fromEntries(keys
  .filter(k => object?.[k] !== undefined).map(k => [k, object[k]]));
const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);

const uncertain = snapshot => snapshot?.error || snapshot?.outcome?.status === 'unknown'
  || snapshot?.historical === true
  || (snapshot?.update != null && snapshot.update.kind !== 'snapshot')
  || [snapshot?.storage, snapshot?.recording].some(d => d != null && d.status !== 'ok');

function project(snapshot) {
  const o = snapshot?.observation;
  if (!snapshot?.sessionId || !o?.location?.id || !point(o.you)) return null;
  const cells = new Map();
  for (const c of o.world ?? []) {
    if (!point(c)) continue;
    cells.set(key(c), {
      x: c.x, y: c.y, visible: c.visible === true,
      terrain: pick(c.terrain, ['type', 'orientation']),
      occupant: c.occupant ? pick(c.occupant, ['kind', 'mark', 'color', 'appearance', 'attitude']) : null,
      objects: (c.objects ?? []).map(v => pick(v, ['kind', 'mark', 'color'])).sort((a, b) => stable(a).localeCompare(stable(b))),
    });
  }
  const n = o.neighborhood;
  if (n?.status === 'available' && n.basis?.revision === snapshot.revision
    && n.basis?.levelId === o.location.id && point(n.basis.origin)
    && key(n.basis.origin) === key(o.you)) {
    for (const c of n.cells ?? []) {
      if (!point(c) || !c.inBounds) continue;
      const previous = cells.get(key(c)) ?? { x: c.x, y: c.y };
      cells.set(key(c), {
        ...previous, visible: c.visible === true,
        terrain: pick(c.terrain, ['type', 'orientation']),
        occupant: c.occupant ? pick(c.occupant, ['kind', 'mark', 'color', 'appearance', 'attitude']) : null,
        objects: (c.objects ?? []).map(v => pick(v, ['kind', 'mark', 'color'])).sort((a, b) => stable(a).localeCompare(stable(b))),
        hazards: [...(c.hazards ?? [])].sort(),
        door: pick(c.door, ['lock']),
        movement: pick(c.movement, ['knownRestriction', 'requiresSqueeze']),
      });
    }
  }
  return { sessionId: snapshot.sessionId, level: o.location.id, origin: { ...o.you }, cells };
}

function obstruction(p, target) {
  return p?.cells.get(key(target)) ?? null;
}

function changedObstacle(before, after) {
  // Losing visibility or dropping optional layers is not an observed clearing.
  if (!before?.visible || !after?.visible) return false;
  return ['terrain', 'occupant', 'objects', 'hazards', 'door', 'movement'].some(k => {
    if (k === 'terrain' && (!before.terrain?.type || !after.terrain?.type
      || [before.terrain.type, after.terrain.type].includes('unknown'))) return false;
    if (k === 'door' && (!before.door?.lock || !after.door?.lock
      || [before.door.lock, after.door.lock].includes('unknown'))) return false;
    return before[k] !== undefined && after[k] !== undefined && stable(before[k]) !== stable(after[k]);
  });
}

function knowledge(p, target) {
  return new Set([...p.cells.values()].filter(c => key(c) === key(target))
    .filter(c => c.terrain.type && c.terrain.type !== 'unknown')
    .map(c => `${p.level}:${key(c)}:${stable(c.terrain)}`));
}

/** See module contract above. No reset method: a new run needs a new budget. */
export function createProgressBudget({ maxAttempts = 8, maxNoProgress = 1 } = {}) {
  for (const n of [maxAttempts, maxNoProgress]) {
    if (!Number.isSafeInteger(n) || n < 1) throw new RangeError('Budgets must be positive safe integers');
  }
  const intents = new Map();
  let pending = null, halted = null, sessionId = null;
  const stop = (reason, context = {}) => ({ allowed: false, progress: false, reason, ...context });
  return {
    begin({ intent, snapshot, target, candidates = [] }) {
      if (halted) return stop(halted);
      if (uncertain(snapshot)) {
        halted = 'uncertainResponse'; return stop(halted);
      }
      if (pending) return stop('pendingReceipt');
      if (typeof intent !== 'string' || !intent || !point(target)) return stop('invalidIntent');
      if (snapshot?.decision) return stop('decision');
      if (snapshot?.ended || snapshot?.end) return stop('ended');
      const before = project(snapshot);
      if (!before) return stop('unknownSnapshot');
      sessionId ??= before.sessionId;
      if (sessionId !== before.sessionId) return stop('differentSession');
      const state = intents.get(intent) ?? { attempts: 0, failures: new Map(), known: new Set() };
      intents.set(intent, state);
      for (const fact of knowledge(before, target)) state.known.add(fact);
      const edge = `${before.level}:${key(before.origin)}>${key(target)}`;
      const blocked = obstruction(before, target);
      const alternatives = candidates.filter(point).filter(c => key(c) !== key(target))
        .filter((c, i, all) => all.findIndex(a => key(a) === key(c)) === i)
        .map(c => obstruction(before, c)).filter(Boolean);
      const context = structuredClone({ obstruction: blocked, alternatives, attempts: state.attempts });
      if (state.attempts >= maxAttempts) return stop('attemptLimit', context);
      const failure = state.failures.get(edge);
      if (failure?.count >= maxNoProgress && !changedObstacle(failure.obstruction, blocked)) {
        return stop('noProgress', context);
      }
      if (failure && changedObstacle(failure.obstruction, blocked)) state.failures.delete(edge);
      state.attempts++;
      const token = Object.freeze({});
      pending = { token, state, before, target: { ...target }, edge, context,
        candidates: alternatives.map(c => ({ x: c.x, y: c.y })) };
      return { allowed: true, token, ...context, attempts: state.attempts };
    },

    settle(token, { status = 'unknown', snapshot } = {}) {
      if (halted) return stop(halted);
      if (!pending || pending.token !== token) {
        halted = 'invalidReceiptToken'; return stop(halted);
      }
      const { state, before, target, edge, context, candidates } = pending;
      pending = null;
      const after = status === 'ok' && !uncertain(snapshot) ? project(snapshot) : null;
      if (status !== 'ok' || uncertain(snapshot)
        || !after || after.sessionId !== before.sessionId) {
        halted = status === 'error' || snapshot?.error ? 'errorResponse' : 'uncertainResponse';
        return stop(halted, context);
      }
      const moved = before.level !== after.level || key(before.origin) !== key(after.origin);
      const obstacleChanged = before.level === after.level
        && changedObstacle(obstruction(before, target), obstruction(after, target));
      const facts = knowledge(after, target);
      const revealed = [...facts].some(fact => !state.known.has(fact));
      for (const fact of facts) state.known.add(fact);
      const progress = moved || obstacleChanged || revealed;
      // Revealing terrain is progress, but cannot erase a failed attempt at this edge.
      if (!moved && !obstacleChanged) {
        const failure = state.failures.get(edge);
        state.failures.set(edge, { count: (failure?.count ?? 0) + 1, obstruction: obstruction(after, target) });
      } else state.failures.delete(edge);
      const reason = snapshot.decision ? 'decision' : snapshot.ended || snapshot.end ? 'ended'
        : state.attempts >= maxAttempts ? 'attemptLimit' : !progress ? 'noProgress' : 'progress';
      return { allowed: reason === 'progress', progress, reason,
        changes: { moved, obstacleChanged, revealed }, attempts: state.attempts,
        obstruction: structuredClone(obstruction(after, target)),
        alternatives: before.level === after.level
          ? structuredClone(candidates.map(c => obstruction(after, c)).filter(Boolean)) : [] };
    },
  };
}
