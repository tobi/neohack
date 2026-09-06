import type { ScriptState, ScriptResult } from './script.js';
import type { Hero, Entity } from './hero.js';
import type { Cell, Decision, ItemRef, Observation, Snapshot, WorldEvent } from './types.js';

export interface CellChange { readonly before: Cell | undefined; readonly after: Cell | undefined }
export type ItemSighting =
  | { readonly source: 'inventory' | 'here'; readonly item: ItemRef }
  | { readonly source: 'map'; readonly cell: Cell };
export type StopReason = 'stopped' | 'idle' | 'ended' | 'decision' | 'uncertain' | 'noTurnListener' | 'yielded';
export interface BotResult { readonly reason: StopReason; readonly snapshot: Snapshot }
/** Observation notifications precede turn. All facts belong to detail.snapshot. */
export interface HeroEventDetails {
  /** Main strategy callback. Await actions here; standing decisions are explicit. */
  turn: { readonly snapshot: Snapshot };
  /** Actionable, revision-bound review. Cancel before dropping; re-read items after input. */
  beforeLoot: {
    readonly snapshot: Snapshot;
    readonly source: 'pickup' | 'container';
    readonly decision: Extract<Decision, {kind:'choice'}>;
    /** Explicitly choose offered IDs (container options include take/put). Empty selection cancels. */
    select(ids: readonly number[]): Promise<Snapshot>;
    cancel(): Promise<Snapshot>;
  };
  /** Confirmed acquisition, including partial quantities and inventory stack merges. */
  itemLooted: { readonly snapshot: Snapshot; readonly loot: Extract<WorldEvent, {type:'itemLooted'}> };
  /** Accessible contents were actually disclosed. A locked/trapped attempt is not this event. */
  containerOpened: { readonly snapshot: Snapshot; readonly container: Extract<WorldEvent, {type:'containerOpened'}> };
  snapshotChange: { readonly snapshot: Snapshot; readonly previous: Snapshot | null };
  /** Proposed script-state change. Deny before commit; never vetoes engine facts. */
  stateChange: { readonly from:ScriptState; readonly to:ScriptState; deny():void };
  /** Also emitted for the initial level. No map correspondence is invented across levels. */
  enterLevel: { readonly snapshot: Snapshot; readonly from: Observation['location'] | null; readonly to: Observation['location'] };
  mapChange: { readonly snapshot: Snapshot; readonly changes: readonly CellChange[] };
  /** A new visible sighting, not proof of birth or persistent monster identity. */
  entitySeen: { readonly snapshot: Snapshot; readonly entity: Entity };
  /** A previous sighting no longer present at that square. Does not imply death. */
  entityLost: { readonly snapshot: Snapshot; readonly cell: Cell };
  /** Disclosed item ID in inventory/here, or visible map glyphs without invented IDs. */
  itemSeen: { readonly snapshot: Snapshot; readonly sighting: ItemSighting };
  inventoryChange: { readonly snapshot: Snapshot; readonly previous: Snapshot | null };
  vitalsChange: { readonly snapshot: Snapshot; readonly before: Observation['vitals'] | null; readonly after: Observation['vitals'] };
  decision: { readonly snapshot: Snapshot; readonly decision: Snapshot['decision'] };
  message: { readonly snapshot: Snapshot; readonly text: string };
  actionResult: { readonly snapshot: Snapshot; readonly outcome: Snapshot['outcome'] };
  end: { readonly snapshot: Snapshot; readonly end: Snapshot['end'] };
  stop: BotResult;
  error: { readonly snapshot: Snapshot; readonly error: unknown };
}
export type HeroEventName = keyof HeroEventDetails;
export interface HeroEvent<K extends HeroEventName> {
  readonly type: K;
  readonly target: Hero;
  readonly detail: HeroEventDetails[K];
}
export type HeroListener<K extends HeroEventName> = (event: HeroEvent<K>) => ScriptResult | Snapshot | Promise<ScriptResult | Snapshot>;
type Registration = { listener: HeroListener<any>; once: boolean };
/** Async listeners run in registration order. One turn listener owns action selection. */
export class HeroEventListeners {
  private readonly listeners = new Map<HeroEventName, Registration[]>();
  add<K extends HeroEventName>(type: K, listener: HeroListener<K>, options: { once?: boolean } = {}) {
    const list = this.listeners.get(type) ?? [];
    if (list.some(entry => entry.listener === listener)) return;
    if (type === 'turn' && list.length) throw Error('Use one turn listener to coordinate your strategy.');
    list.push({ listener, once: !!options.once }); this.listeners.set(type, list);
  }
  remove<K extends HeroEventName>(type: K, listener: HeroListener<K>) {
    const list = this.listeners.get(type); if (!list) return;
    const index = list.findIndex(entry => entry.listener === listener); if (index >= 0) list.splice(index, 1);
  }
  has(type: HeroEventName) { return !!this.listeners.get(type)?.length; }
  async emit<K extends HeroEventName>(hero: Hero, type: K, detail: HeroEventDetails[K], isCurrent: () => boolean = () => true, onResult: (value:unknown)=>Promise<void> = value=>hero.applyEventResult(value)) {
    const event = Object.freeze({ type, target: hero, detail: Object.freeze(detail) });
    for (const entry of [...(this.listeners.get(type) ?? [])]) {
      if (!isCurrent() || hero.state === null) break;
      if (!this.listeners.get(type)?.includes(entry)) continue;
      if (entry.once) this.remove(type, entry.listener);
      const revision=hero.stateRevision;
      const result = await entry.listener(event);
      if (isCurrent() && hero.state !== null && hero.stateRevision===revision) await onResult(result);
    }
  }
}
