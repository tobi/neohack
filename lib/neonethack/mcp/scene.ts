import type {DecisionFrame, AgentScene} from './frame.js';

export type {DecisionFrame, AgentScene} from './frame.js';
export {SceneProjector} from './compact.js';
export type SceneRemoval = 'automaticPickup' | 'navigation' | 'world' | 'knowledge';
export type DeltaScene = Partial<Omit<AgentScene, 'kind'>> & {
  kind: 'delta';
  baseViewId: string;
  /** Explicitly remove optional fields; omission otherwise retains them. */
  remove?: SceneRemoval[];
  worldRemoved?: {x: number; y: number}[];
};
export type SceneFrame = Omit<DecisionFrame, 'scene'> & {scene: AgentScene | DeltaScene | null};
type Basis = NonNullable<DecisionFrame['basis']>;
type Held = {frame: DecisionFrame; views: Set<string>};
const required = ['self', 'nearby', 'entities', 'features', 'map', 'inventory', 'inventoryKnown', 'here', 'perception', 'end'] as const;
const optional = ['automaticPickup', 'navigation', 'world', 'knowledge'] as const;
const cellKey = (cell: {x: number; y: number}) => `${cell.x},${cell.y}`;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function fail(reason: string): never {
  throw new Error(`${reason}; request a fresh observe snapshot. Never resend gameplay to repair scene state.`);
}
function validateBasis(basis: DecisionFrame['basis']): asserts basis is Basis {
  if (!basis || ![basis.sessionId, basis.viewId, basis.levelId].every(value => typeof value === 'string' && value.length > 0) ||
    !Number.isSafeInteger(basis.revision) || basis.revision < 0 || !Number.isSafeInteger(basis.turn) || basis.turn < 0)
    fail('Invalid scene basis');
}
function validateWorld(world: NonNullable<AgentScene['world']>) {
  if (!Array.isArray(world)) fail('Invalid world cells');
  const keys = new Set<string>();
  for (const cell of world) {
    if (!cell || !Number.isSafeInteger(cell.x) || !Number.isSafeInteger(cell.y) || keys.has(cellKey(cell))) fail('Invalid or duplicate world cell');
    keys.add(cellKey(cell));
  }
}
function validateSnapshot(scene: AgentScene) {
  if (required.some(key => !Object.hasOwn(scene, key))) fail('Incomplete scene snapshot');
  for (const key of ['entities', 'features', 'inventory'] as const) if (!Array.isArray(scene[key])) fail(`Invalid scene ${key}`);
  if (scene.world !== undefined) validateWorld(scene.world);
}
function materialize(previous: AgentScene, delta: DeltaScene): AgentScene {
  const {kind, baseViewId, remove = [], worldRemoved = [], world, ...changes} = delta;
  if (!Array.isArray(remove) || new Set(remove).size !== remove.length || remove.some(key => !optional.some(field => field === key))) fail('Invalid scene removal');
  if (remove.some(key => Object.hasOwn(changes, key) || (key === 'world' && (world !== undefined || worldRemoved.length)))) fail('Conflicting scene removal');
  const scene = {...structuredClone(previous), ...changes};
  for (const key of remove) Reflect.deleteProperty(scene, key);
  if (world !== undefined) validateWorld(world);
  if (!Array.isArray(worldRemoved) || worldRemoved.some(cell => !cell || !Number.isSafeInteger(cell.x) || !Number.isSafeInteger(cell.y))) fail('Invalid world removals');
  if (world !== undefined || worldRemoved.length) {
    if (!previous.world && world === undefined) fail('Missing world baseline');
    const cells = new Map((previous.world ?? []).map(cell => [cellKey(cell), cell]));
    for (const cell of worldRemoved) {
      if (!cells.delete(cellKey(cell)) || world?.some(changed => cellKey(changed) === cellKey(cell))) fail('Invalid or conflicting world removal');
    }
    for (const cell of world ?? []) cells.set(cellKey(cell), cell);
    scene.world = [...cells.values()].sort((a, b) => a.y - b.y || a.x - b.x);
  }
  validateSnapshot(scene);
  return scene;
}

/** One reducer may hold interleaved sessions. Rejected frames leave every
 * baseline intact. A scene-less reply stays scene-less and advances nothing. */
export class SceneReader {
  private readonly sessions = new Map<string, Held>();

  current(sessionId: string): DecisionFrame | undefined {
    const held = this.sessions.get(sessionId);
    return held ? structuredClone(held.frame) : undefined;
  }

  apply(frame: SceneFrame): DecisionFrame {
    if (frame.version !== 2) fail('Unsupported scene frame version');
    if (!frame.scene) return {...structuredClone(frame), scene: null};
    validateBasis(frame.basis);
    const {basis} = frame, held = this.sessions.get(basis.sessionId), previous = held?.frame;
    if (previous?.basis && (basis.revision < previous.basis.revision || basis.turn < previous.basis.turn ||
      (held?.views.has(basis.viewId) && basis.viewId !== previous.basis.viewId))) fail('Stale scene view');
    let scene: AgentScene;
    if (frame.scene.kind === 'snapshot') {
      scene = structuredClone(frame.scene);
      validateSnapshot(scene);
    } else if (frame.scene.kind === 'delta') {
      if (!previous?.scene || !previous.basis || previous.basis.sessionId !== basis.sessionId ||
        previous.basis.levelId !== basis.levelId || previous.basis.viewId !== frame.scene.baseViewId ||
        basis.viewId === frame.scene.baseViewId) fail('Missing or stale scene delta baseline');
      scene = materialize(previous.scene, structuredClone(frame.scene));
    } else fail('Unknown scene kind');
    if (scene.self.location.id !== basis.levelId) fail('Scene level does not match its basis');
    // Free full-state queries may enrich the same view with optional sections.
    if (previous?.basis?.viewId === basis.viewId && (!equal(previous.basis, basis) ||
      required.some(key => !equal(previous.scene?.[key], scene[key])))) fail('Reused scene view with different state');
    const result: DecisionFrame = {...structuredClone(frame), scene};
    const views = previous?.basis?.revision === basis.revision ? new Set(held?.views) : new Set<string>();
    views.add(basis.viewId);
    this.sessions.set(basis.sessionId, {frame: structuredClone(result), views});
    return result;
  }

  /** Bind explicitly requested intent to the caller's retained view, never a
   * silently refreshed one. Decision IDs remain the caller's explicit input. */
  arguments(sessionId: string): {sessionId: string; viewId: string};
  arguments<T extends Record<string, unknown>>(sessionId: string, input: T): T & {sessionId: string; viewId: string};
  arguments(sessionId: string, input: Record<string, unknown> = {}): Record<string, unknown> {
    const basis = this.sessions.get(sessionId)?.frame.basis;
    if (!basis) fail('Missing scene basis');
    if ((input.sessionId !== undefined && input.sessionId !== sessionId) ||
      (input.viewId !== undefined && input.viewId !== basis.viewId)) fail('Conflicting caller scene basis');
    return {...input, sessionId, viewId: basis.viewId};
  }
}
