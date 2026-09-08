const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Decode public safe-integer {x,y} coordinates without coercion or a faraway fallback. */
export function decodePosition(position) {
  if (!record(position) || !Object.hasOwn(position, 'x') || !Object.hasOwn(position, 'y')
      || !Number.isSafeInteger(position.x) || !Number.isSafeInteger(position.y)) return null;
  return [position.x, position.y];
}

/**
 * Assess a reconstructed public {observation:{you,world?},creatures?} snapshot.
 * World occupants use cell x/y; compact creatures use position:{x,y}. At least
 * one collection must be supplied. The caller owns session/revision freshness
 * and compact reconstruction; raw deltas are rejected here.
 *
 * Harness policy: an apparent eye within Chebyshev distance 2 is unsafe; an
 * unidentified creature within distance 1, or malformed coordinates, is unknown.
 * Appearance is a perceived signal, never proof of species or hidden abilities.
 * This does not assess every combat hazard. "clear" only means this policy found
 * no signal; it is not a safety guarantee or authorization to dispatch an action.
 *
 * Returns {status:'clear'|'unsafe'|'unknown', blocked, hero:[x,y]|null,
 * threats, unknowns}. Evidence includes source/index, reason, and where known
 * position, appearance and distance. Both unsafe and unknown block this policy.
 * No I/O, engine input, message parsing, decision answers or snapshot mutation.
 */
export function assessProximityThreats(snapshot) {
  const hero = decodePosition(snapshot?.observation?.you);
  const threats = [];
  const unknowns = [];
  if (!hero) unknowns.push({ source: 'hero', reason: 'invalid-position' });
  if (snapshot?.update?.kind === 'delta') {
    unknowns.push({ source: 'snapshot', reason: 'unreconstructed-delta' });
  }

  function assess(creature, coordinates, source, index) {
    const position = decodePosition(coordinates);
    const appearance = typeof creature.appearance === 'string' && creature.appearance.trim()
      ? creature.appearance : null;
    const evidence = { source, index, position, appearance };
    if (!position) {
      unknowns.push({ ...evidence, reason: 'invalid-position' });
      return;
    }
    if (!hero) return;
    const distance = Math.max(Math.abs(position[0] - hero[0]), Math.abs(position[1] - hero[1]));
    if (appearance && /\beye\b/i.test(appearance) && distance <= 2) {
      threats.push({ ...evidence, distance, reason: 'nearby-eye-appearance' });
    } else if (!appearance && distance <= 1) {
      unknowns.push({ ...evidence, distance, reason: 'unknown-nearby-identity' });
    }
  }

  let supplied = false;
  for (const [source, owner, key] of [
    ['world', snapshot?.observation, 'world'], ['creatures', snapshot, 'creatures'],
  ]) {
    if (!record(owner) || !Object.hasOwn(owner, key)) continue;
    supplied = true;
    const collection = owner[key];
    if (!Array.isArray(collection)) {
      unknowns.push({ source, reason: 'invalid-collection' });
      continue;
    }
    for (const [index, entry] of collection.entries()) {
      if (!record(entry)) {
        unknowns.push({ source, index, reason: 'invalid-entry' });
        continue;
      }
      if (source === 'world') {
        if (!Object.hasOwn(entry, 'occupant')) continue;
        const occupant = entry.occupant;
        if (!record(occupant)) {
          unknowns.push({ source, index, reason: 'invalid-occupant' });
          continue;
        }
        if (occupant.kind === 'self') continue;
        if (!['creature', 'ally'].includes(occupant.kind)) {
          unknowns.push({ source, index, reason: 'unknown-occupant-kind' });
          continue;
        }
        assess(occupant, entry, source, index);
      } else {
        assess(entry, entry.position, source, index);
      }
    }
  }
  if (!supplied) unknowns.push({ source: 'snapshot', reason: 'missing-perception' });
  const status = threats.length ? 'unsafe' : unknowns.length ? 'unknown' : 'clear';
  return { status, blocked: status !== 'clear', hero, threats, unknowns };
}
