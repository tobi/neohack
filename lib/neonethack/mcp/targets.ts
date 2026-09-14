import type {Cell, Compass, Snapshot} from '../typescript/types.js';
import {compassOffsets} from '../typescript/navigator.js';
import {cellMark} from './map.js';

export type TargetDirection = Compass | 'self' | 'up' | 'down';
export type TargetPosition = {x: number; y: number};
export type AgentTarget = {direction: TargetDirection} | {position: TargetPosition} |
  {ref: string} | {symbol: string; scope: 'adjacent' | 'level'};
export interface TargetOptions {scope: 'adjacent' | 'level'; vertical?: boolean; self?: boolean}
export interface ResolvedTarget {position?: TargetPosition; direction?: TargetDirection; ref?: string}
export interface TargetCandidate extends ResolvedTarget {position: TargetPosition; description: string}
export type TargetErrorCode = 'invalidTarget' | 'targetNotFound' | 'ambiguousTarget' | 'staleTarget' | 'targetOutOfBounds' | 'targetOutOfScope';
export interface TargetErrorDetails {candidates?: TargetCandidate[]; position?: TargetPosition; ref?: string}
export class TargetError extends Error {
  readonly code: TargetErrorCode;
  readonly details: TargetErrorDetails;
  constructor(code: TargetErrorCode, message: string, details: TargetErrorDetails = {}) {
    super(message);
    this.name = 'TargetError';
    this.code = code;
    this.details = details;
  }
}

/** A reference identifies a displayed square in one snapshot, never a creature. */
export function targetRef(snapshot: Snapshot, x: number, y: number): string {
  return `target:${encodeURIComponent(snapshot.sessionId)}:${snapshot.revision}:${x}:${y}`;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function isCompass(value: unknown): value is Compass {
  return typeof value === 'string' && Object.hasOwn(compassOffsets, value);
}
function validate(target: unknown): asserts target is AgentTarget {
  if (record(target)) {
    if (exactKeys(target, ['direction']) && typeof target.direction === 'string' && (isCompass(target.direction) || ['self', 'up', 'down'].includes(target.direction))) return;
    if (exactKeys(target, ['position']) && record(target.position) && exactKeys(target.position, ['x', 'y']) &&
      Number.isSafeInteger(target.position.x) && Number.isSafeInteger(target.position.y)) return;
    if (exactKeys(target, ['ref']) && typeof target.ref === 'string' && target.ref.length > 0) return;
    if (exactKeys(target, ['symbol', 'scope']) && typeof target.symbol === 'string' && /^[!-~]$/.test(target.symbol) &&
      (target.scope === 'adjacent' || target.scope === 'level')) return;
  }
  throw new TargetError('invalidTarget', 'Supply exactly one target branch: direction, position, ref, or symbol with scope.');
}
function relative(snapshot: Snapshot, position: TargetPosition): Compass | 'self' | undefined {
  const you = snapshot.observation.you;
  if (!you) return undefined;
  const dx = Math.sign(position.x - you.x), dy = Math.sign(position.y - you.y);
  if (dx === 0 && dy === 0) return 'self';
  return (Object.keys(compassOffsets) as Compass[]).find(key => {
    const [x, y] = compassOffsets[key];
    return x === dx && y === dy;
  });
}
function atPosition(snapshot: Snapshot, position: TargetPosition, options: TargetOptions): ResolvedTarget {
  const {x, y} = position, you = snapshot.observation.you;
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 1 || x > 79 || y < 0 || y > 20) throw new TargetError('targetOutOfBounds', 'Target is outside the level bounds.', {position});
  if (options.scope === 'adjacent' && !you) throw new TargetError('targetNotFound', 'The hero position is unknown.');
  const direction = relative(snapshot, position);
  if (direction === 'self' && !options.self) throw new TargetError('targetOutOfScope', 'This target does not allow self.', {position});
  if (options.scope === 'adjacent' && you && Math.max(Math.abs(x - you.x), Math.abs(y - you.y)) > 1)
    throw new TargetError('targetOutOfScope', 'Target must be adjacent.', {position});
  // Remote coordinates have a relative bearing, but are not one-step directions.
  const adjacent = you && Math.max(Math.abs(x - you.x), Math.abs(y - you.y)) <= 1;
  return {position: {x, y}, ...(adjacent && direction ? {direction} : {}), ref: targetRef(snapshot, x, y)};
}
function description(cell: Cell, direction: TargetDirection | undefined): string {
  if (direction === 'self') return 'you';
  if (cell.occupant) return cell.occupant.appearance ?? (cell.occupant.kind === 'ally' ? 'ally' : 'creature');
  const object = cell.objects?.[0];
  if (object) return object.known?.appearance ?? (object.kind === 'boulder' ? 'boulder' : object.category ?? 'object');
  return cell.terrain.type;
}

/** Resolve only against the supplied perceived frame. No game input or eligibility queries. */
export function resolveTarget(snapshot: Snapshot, target: AgentTarget, options: TargetOptions): ResolvedTarget {
  validate(target);
  if ('direction' in target) {
    const direction = target.direction;
    if (direction === 'up' || direction === 'down') {
      if (!options.vertical) throw new TargetError('targetOutOfScope', 'Vertical targeting is not allowed.');
      return {direction};
    }
    if (direction === 'self' && !options.self) throw new TargetError('targetOutOfScope', 'This target does not allow self.');
    const you = snapshot.observation.you;
    if (!you) throw new TargetError('targetNotFound', 'The hero position is unknown.');
    const [dx, dy] = direction === 'self' ? [0, 0] as const : compassOffsets[direction];
    return atPosition(snapshot, {x: you.x + dx, y: you.y + dy}, options);
  }
  if ('position' in target) return atPosition(snapshot, target.position, options);
  if ('ref' in target) {
    const parts = /^target:([^:]*):(\d+):(-?\d+):(-?\d+)$/.exec(target.ref);
    if (!parts) throw new TargetError('invalidTarget', 'Malformed target reference.', {ref: target.ref});
    const x = Number(parts[3]), y = Number(parts[4]);
    if (target.ref !== targetRef(snapshot, x, y)) throw new TargetError('staleTarget', 'Reference does not belong to this snapshot.', {ref: target.ref});
    return atPosition(snapshot, {x, y}, options);
  }
  if (target.scope === 'level' && options.scope === 'adjacent')
    throw new TargetError('targetOutOfScope', 'This operation only allows adjacent symbol matching.');
  const you = snapshot.observation.you;
  if (target.scope === 'adjacent' && !you) throw new TargetError('targetNotFound', 'The hero position is unknown.');
  const candidates: TargetCandidate[] = [];
  for (const cell of snapshot.observation.world) {
    const direction = relative(snapshot, cell);
    if (direction === 'self' && (target.scope === 'adjacent' || !options.self)) continue;
    if (target.scope === 'adjacent' && you && Math.max(Math.abs(cell.x - you.x), Math.abs(cell.y - you.y)) > 1) continue;
    if (cellMark(cell, you) !== target.symbol) continue;
    const resolved = atPosition(snapshot, {x: cell.x, y: cell.y}, options);
    candidates.push({...resolved, position: {x: cell.x, y: cell.y}, ...(direction ? {direction} : {}), description: description(cell, direction)});
  }
  // renderMap always places a known hero, even when world omits that cell.
  // Symbol targeting must see that same displayed square, without inventing
  // terrain or suppressing other apparent '@' occupants from ambiguity.
  if (you && target.symbol === '@' && target.scope === 'level' && options.self &&
      !snapshot.observation.world.some(cell => cell.x === you.x && cell.y === you.y)) {
    candidates.push({...atPosition(snapshot, you, options), position: {...you}, description: 'you'});
  }
  if (!candidates.length) throw new TargetError('targetNotFound', 'No displayed symbol matches in the requested scope.');
  if (candidates.length > 1) throw new TargetError('ambiguousTarget', 'Multiple displayed squares match; choose a coordinate or reference.', {candidates});
  return atPosition(snapshot, candidates[0]!.position, options);
}
