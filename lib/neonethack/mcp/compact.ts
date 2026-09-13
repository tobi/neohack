import type {DecisionFrame, AgentScene} from './frame.js';
import {SceneReader, type SceneFrame, type DeltaScene, type SceneRemoval} from './scene.js';

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const cellKey = (cell: {x: number; y: number}) => `${cell.x},${cell.y}`;

/** Opt-in presentation deltas. Baselines never authorize or replay game input. */
export class SceneProjector {
  private readonly reader = new SceneReader();
  private readonly ambiguous = new Set<string>();

  project(frame: DecisionFrame, sinceViewId?: string): SceneFrame {
    const previous = frame.basis ? this.reader.current(frame.basis.sessionId) : undefined;
    const result = this.reader.apply(frame);
    if (result.scene && result.basis && previous?.scene && previous.basis?.viewId === result.basis.viewId &&
      !equal(previous.scene, result.scene)) this.ambiguous.add(result.basis.sessionId);
    const ambiguous = result.basis ? this.ambiguous.has(result.basis.sessionId) : false;
    // The same view can be returned with optional full-state enrichment. A
    // dropped enrichment reply makes that view ID ambiguous as a delta base;
    // establish a fresh snapshot at the next view before sending deltas again.
    if (result.scene && result.basis && previous?.basis?.viewId !== result.basis.viewId)
      this.ambiguous.delete(result.basis.sessionId);
    if (!result.scene || !result.basis || !previous?.scene || !previous.basis ||
      sinceViewId !== previous.basis.viewId || result.basis.levelId !== previous.basis.levelId ||
      result.basis.viewId === previous.basis.viewId || ambiguous) return result;
    const before = previous.scene, after = result.scene;
    const scene: DeltaScene = {kind: 'delta', baseViewId: previous.basis.viewId};
    const changes: Partial<AgentScene> = {};
    // Non-world arrays replace in full; world entries replace complete cells.
    for (const key of Object.keys(after) as (keyof AgentScene)[]) {
      if (key !== 'kind' && key !== 'world' && !equal(before[key], after[key]))
        Object.assign(changes, {[key]: after[key]});
    }
    Object.assign(scene, changes);
    const remove = (Object.keys(before) as (keyof AgentScene)[]).filter((key): key is SceneRemoval =>
      (key === 'automaticPickup' || key === 'navigation' || key === 'world' || key === 'knowledge') && !Object.hasOwn(after, key));
    if (remove.length) scene.remove = remove;
    if (after.world) {
      if (!before.world) scene.world = after.world;
      else {
        const cells = new Map(before.world.map(cell => [cellKey(cell), cell]));
        const current = new Set(after.world.map(cellKey));
        const changed = after.world.filter(cell => !equal(cell, cells.get(cellKey(cell))));
        const removed = before.world.filter(cell => !current.has(cellKey(cell))).map(cell => ({x: cell.x, y: cell.y}));
        if (changed.length) scene.world = changed;
        if (removed.length) scene.worldRemoved = removed;
      }
    }
    return {...result, scene};
  }
}
