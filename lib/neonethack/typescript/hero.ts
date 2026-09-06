import { attachController } from './lifecycle.js';
import { HeroEventListeners, type HeroEventName, type HeroListener, type BotResult, type StopReason, type CellChange } from './hero-events.js';
import type { Game } from './client.js';
import type { CellActions, Cell, Item, ItemRef, Snapshot } from './types.js';
import { direction, entities } from './vocabulary.js';
export { direction, entities } from './vocabulary.js';

/** Context supplied to a workshop bot. Actions must be awaited. */
export interface BotContext { hero: Hero; game: Game; log: (...values: unknown[]) => void }
export interface BotDefinition { initialize(context: BotContext): void | Promise<void> }
/** One initialization callback, with contextual types in JS and TS. Register your turn listener here. */
export function defineBot(bot: BotDefinition): BotDefinition { return bot; }
/** Host a bot on an existing game; no game creation, implicit input, or retries. */
export async function runBot(game: Game, bot: BotDefinition, log: BotContext['log'] = () => {}): Promise<BotResult> {
  if (!bot || typeof bot.initialize !== 'function') throw Error('Export defineBot({ initialize({ hero, log }) { ... } }) from main.ts.');
  const hero = new Hero(game);
  return hero.initialize(() => bot.initialize({ hero, game, log }));
}

type Basis = { game: Game; revision: number; level: string };
const bases = new WeakMap<object, Basis>();
function bind(value: object, game: Game, frame = game.state) {
  bases.set(value, { game, revision: frame.revision, level: frame.observation.location.id });
}
function current(value: object, game: Game) {
  const basis = bases.get(value);
  if (!basis || basis.game !== game || basis.revision !== game.state.revision || basis.level !== game.observation.location.id)
    throw Error('Stale or foreign handle. Sense entities or read inventory again after each action.');
  return { expectedRevision: basis.revision };
}
const entityKey = Symbol('perceived entity');
const species = new Set<string>(Object.values(entities).filter(v => !v.startsWith('@')));
/** A visible creature at one revision, not a persistent monster ID. Never construct these yourself. */
export class Entity {
  readonly type: entities | undefined;
  readonly appearance: string | undefined;
  readonly attitude: 'hostile' | 'peaceful' | 'tame' | undefined;
  readonly position: readonly [x: number, y: number];
  /** Relative coordinates: positive x is east, positive y is south. */
  readonly offset: readonly [dx: number, dy: number];
  /** Geometric Chebyshev distance; does not imply a traversable path. */
  readonly distance: number;
  readonly kind: 'creature' | 'ally';
  /** @internal Obtain an Entity with Hero.sense() or Hero.senseClosest(). */
  constructor(key: symbol, game: Game, cell: Cell, frame = game.state) {
    if (key !== entityKey || !cell.occupant || !frame.observation.you) throw Error('Use hero.sense()');
    this.appearance = cell.occupant.appearance;
    this.type = this.appearance && species.has(this.appearance) ? this.appearance as entities : undefined;
    this.attitude = cell.occupant.attitude;
    this.kind = cell.occupant.kind as 'creature' | 'ally';
    this.position = Object.freeze([cell.x, cell.y]);
    this.offset = Object.freeze([cell.x - frame.observation.you.x, cell.y - frame.observation.you.y]);
    this.distance = Math.max(Math.abs(this.offset[0]), Math.abs(this.offset[1]));
    bind(this, game, frame); Object.freeze(this);
  }
}

/** A revision-bound item ID or lazy name query. The engine resolves names and rejects ambiguity. */
export class InventoryItem {
  /** Engine-disclosed eligibility. Undefined means unknown; true does not promise safe food. */
  canEat(): boolean | undefined { return this.info?.actions?.includes('eat'); }
  /** An unworn equipment candidate; fit, curses and warnings still belong to the engine. */
  canEquip(): boolean | undefined { return this.info?.usage === undefined ? undefined : this.info.actions?.includes('equip'); }
  pickup(): Promise<Snapshot> { return this.#game.pickup(this.#item, current(this, this.#game)); }
  readonly info: Readonly<ItemRef> | undefined;
  readonly #game: Game;
  readonly #item: Item;
  /** @internal Use hero.inventory.find() or hero.inventory.items. */
  constructor(game: Game, item: Item, info?: ItemRef) {
    this.#game = game; this.#item = typeof item === 'string' ? item : Object.freeze({ ...item });
    this.info = info; bind(this, game); Object.freeze(this);
  }
  /** Attempt eating; warnings and choices remain in hero.decision. Does not promise food is safe. */
  eat(): Promise<Snapshot> { return this.#game.eat(this.#item, current(this, this.#game)); }
  drink(): Promise<Snapshot> { return this.#game.drink(this.#item, current(this, this.#game)); }
  wield(): Promise<Snapshot> { return this.#game.wield(this.#item, current(this, this.#game)); }
  equip(): Promise<Snapshot> { return this.#game.equip(this.#item, current(this, this.#game)); }
  remove(): Promise<Snapshot> { return this.#game.remove(this.#item, current(this, this.#game)); }
  read(): Promise<Snapshot> { return this.#game.read(this.#item, current(this, this.#game)); }
  apply(): Promise<Snapshot> { return this.#game.apply(this.#item, current(this, this.#game)); }
  drop(): Promise<Snapshot> { return this.#game.drop(this.#item, current(this, this.#game)); }
}
export class Inventory {
  constructor(private readonly game: Game) {}
  /** Unknown inventory is distinct from an empty inventory. */
  get freshness() { return this.game.observation.perception.inventory; }
  get items(): readonly InventoryItem[] {
    if (this.freshness !== 'current') throw Error('Inventory is not current.');
    return this.game.observation.inventory.map(item => new InventoryItem(this.game, { id: item.id }, item));
  }
  /** Lazy perceived-name query, not a substring match. Resolves in C at action time;
   * missing or ambiguous names throw WorldError with the engine's blocked response, without choosing an item. */
  find(name: string): InventoryItem {
    if (!name.trim()) throw Error('An item name is required.');
    if (this.freshness !== 'current') throw Error('Inventory is not current.');
    return new InventoryItem(this.game, name);
  }
  /** Select an exact disclosed inventory ID, never a slot or inferred label identity. */
  byId(id: string): InventoryItem | undefined { return this.items.find(item => item.info?.id === id); }
}
const offsets = new Map<string, direction>([
  ['0,-1', direction.north], ['1,-1', direction.northEast], ['1,0', direction.east],
  ['1,1', direction.southEast], ['0,1', direction.south], ['-1,1', direction.southWest],
  ['-1,0', direction.west], ['-1,-1', direction.northWest],
]);
export interface Step extends CellActions { readonly direction: direction }

/** A thin convenience facade over one Game. It never answers decisions or retries uncertain input. */
export class Hero {
  private readonly listeners = new HeroEventListeners();
  private initialized = false;
  private stopped = false;
  /** Register before initialize completes. Notifications are read-only; await input in turn. */
  addEventListener<K extends HeroEventName>(type: K, listener: HeroListener<K>, options: { once?: boolean } = {}): void { this.listeners.add(type, listener, options); }
  removeEventListener<K extends HeroEventName>(type: K, listener: HeroListener<K>): void { this.listeners.remove(type, listener); }
  /** End the bot loop after the active callback. Does not quit or delete the game. */
  stop(): void { this.stopped = true; }
  /** Initialize once, publish observations, then await one turn callback at a time.
   * No action means an idle stop, never an implicit wait or polling loop. */
  async initialize(setup: (hero: Hero) => void | Promise<void>): Promise<BotResult> {
    if (this.initialized) throw Error('Hero.initialize can only be called once.');
    this.initialized = true;
    let phase: 'initialize' | 'notify' | 'turn' = 'initialize';
    const frames: Snapshot[] = [this.state];
    const pending = new Set<Promise<unknown>>();
    const detach = attachController(this.game, {
      beforeInput: () => {
        if (phase !== 'turn' || this.stopped) throw Error('Game input belongs in the turn listener. Await each operation.');
      },
      accepted: frame => { frames.push(frame); },
      scheduled: promise => { pending.add(promise); promise.then(() => pending.delete(promise), () => pending.delete(promise)); },
    });
    let previous: Snapshot | null = null, fingerprint = '';
    const drain = async () => {
      phase = 'notify';
      while (frames.length) {
        const frame = frames.shift()!;
        const next = JSON.stringify(frame);
        if (next === fingerprint) continue;
        fingerprint = next;
        await this.publish(frame, previous); previous = frame;
        if (pending.size) { await Promise.allSettled([...pending]); throw Error('Await every game query in observation listeners.'); }
      }
    };
    const finish = async (reason: StopReason): Promise<BotResult> => {
      phase = 'notify';
      const result = Object.freeze({ reason, snapshot: this.state });
      await this.listeners.emit(this, 'stop', result); return result;
    };
    try {
      await setup(this);
      if (pending.size) { await Promise.allSettled([...pending]); throw Error('Await every game query in initialize.'); }
      while (true) {
        await drain();
        if (this.game.pendingRequest || this.state.outcome.status === 'unknown' || [this.state.storage, this.state.recording].some(d => d && d.status !== 'ok')) return await finish('uncertain');
        if (this.ended) return await finish('ended');
        if (this.stopped) return await finish('stopped');
        if (!this.listeners.has('turn')) return await finish(this.decision ? 'decision' : 'noTurnListener');
        const revision = this.state.revision;
        phase = 'turn';
        await this.listeners.emit(this, 'turn', { snapshot: this.state });
        if (pending.size) { await Promise.allSettled([...pending]); throw Error('Await every game operation in the turn listener.'); }
        await drain();
        if (this.state.revision === revision && !this.stopped && !this.ended && !this.game.pendingRequest && ![this.state.storage, this.state.recording].some(d => d && d.status !== 'ok'))
          return await finish(this.decision ? 'decision' : 'idle');
      }
    } catch (error) {
      await Promise.allSettled([...pending]);
      phase = 'notify';
      await drain();
      await this.listeners.emit(this, 'error', { snapshot: this.state, error });
      throw error;
    } finally { detach(); }
  }
  private async publish(frame: Snapshot, previous: Snapshot | null) {
    const emit = this.listeners.emit.bind(this.listeners, this);
    const now = frame.observation, old = previous?.observation;
    const levelChanged = !old || old.location.id !== now.location.id;
    await emit('stateChange', { snapshot: frame, previous });
    if (levelChanged) await emit('enterLevel', { snapshot: frame, from: old?.location ?? null, to: now.location });
    const beforeCells = new Map((levelChanged ? [] : old!.world).map(cell => [cell.x + ',' + cell.y, cell]));
    const afterCells = new Map(now.world.map(cell => [cell.x + ',' + cell.y, cell]));
    const changes: CellChange[] = [];
    for (const key of new Set([...beforeCells.keys(), ...afterCells.keys()])) {
      const before = beforeCells.get(key), after = afterCells.get(key);
      if (JSON.stringify(before) !== JSON.stringify(after)) changes.push(Object.freeze({ before, after }));
    }
    if (changes.length) await emit('mapChange', { snapshot: frame, changes: Object.freeze(changes) });
    for (const { before, after } of changes) {
      const was = before?.visible && before.occupant && before.occupant.kind !== 'self';
      const seen = after?.visible && after.occupant && after.occupant.kind !== 'self';
      const different = JSON.stringify(before?.occupant) !== JSON.stringify(after?.occupant);
      if (was && (!seen || different)) await emit('entityLost', { snapshot: frame, cell: before! });
      if (seen && (!was || different) && now.you) await emit('entitySeen', { snapshot: frame, entity: new Entity(entityKey, this.game, after!, frame) });
      if (after?.visible && after.objects?.length && (!before?.visible || JSON.stringify(before.objects) !== JSON.stringify(after.objects)))
        await emit('itemSeen', { snapshot: frame, sighting: Object.freeze({ source: 'map', cell: after }) });
    }
    if (!old || JSON.stringify([old.inventory, old.inventoryKnown, old.perception.inventory]) !== JSON.stringify([now.inventory, now.inventoryKnown, now.perception.inventory]))
      await emit('inventoryChange', { snapshot: frame, previous });
    for (const source of ['inventory', 'here'] as const) {
      const known = source === 'inventory' ? now.inventoryKnown && now.perception.inventory === 'current' : now.here.known && now.perception.here === 'current';
      if (!known) continue;
      const samePlace = !levelChanged && old?.you?.x === now.you?.x && old?.you?.y === now.you?.y;
      const oldKnown = old && (source === 'inventory' ? old.inventoryKnown && old.perception.inventory === 'current' : samePlace && old.here.known && old.perception.here === 'current');
      const ids = new Set((oldKnown ? source === 'inventory' ? old.inventory : old.here.items : []).map(item => item.id));
      for (const item of source === 'inventory' ? now.inventory : now.here.items) if (!ids.has(item.id))
        await emit('itemSeen', { snapshot: frame, sighting: Object.freeze({ source, item }) });
    }
    if (JSON.stringify(old?.vitals) !== JSON.stringify(now.vitals)) await emit('vitalsChange', { snapshot: frame, before: old?.vitals ?? null, after: now.vitals });
    if (JSON.stringify(previous?.decision ?? null) !== JSON.stringify(frame.decision)) await emit('decision', { snapshot: frame, decision: frame.decision });
    for (const event of frame.events) if (event.type === 'heard') await emit('message', { snapshot: frame, text: event.text });
    if (previous) await emit('actionResult', { snapshot: frame, outcome: frame.outcome });
    if (frame.ended && !previous?.ended) await emit('end', { snapshot: frame, end: frame.end });
  }
  readonly inventory: Inventory;
  constructor(readonly game: Game) { this.inventory = new Inventory(game); }
  get state() { return this.game.state; }
  get decision() { return this.game.decision; }
  get ended() { return this.game.state.ended; }
  get vitals() { return this.game.observation.vitals; }
  get position() { return this.game.observation.you; }
  get location() { return this.game.observation.location; }
  get map(): readonly Cell[] { return this.game.observation.world; }
  /** Adjacent squares with the C driver's movement facts; no inferred traversability. */
  get steps(): readonly Step[] {
    const neighborhood = this.game.observation.neighborhood;
    if (neighborhood?.status !== 'available') return [];
    return neighborhood.cells.filter(cell => cell.inBounds && cell.movement.relation === 'adjacent')
      .map(cell => Object.freeze({ ...cell, direction: offsets.get(cell.dx + ',' + cell.dy)! }));
  }
  /** Current floor items, or undefined when floor knowledge is unavailable. */
  get itemsHere(): readonly InventoryItem[] | undefined {
    const observation = this.game.observation;
    if (!observation.here.known || observation.perception.here !== 'current') return undefined;
    return observation.here.items.map(item => new InventoryItem(this.game, { id: item.id }, item));
  }
  canDescend(): boolean | undefined {
    const n = this.game.observation.neighborhood;
    if (n?.status !== 'available') return undefined;
    return n.cells.find(c => c.movement.relation === 'here')?.actions.some(a => a.method === 'game.climb' && a.availability === 'attemptable' && a.arguments.direction === 'down');
  }
  /** undefined means hunger was not disclosed. No numerical nutrition inference. */
  isHungry(): boolean | undefined {
    switch (this.vitals.hunger) {
      case 'hungry': case 'weak': case 'fainting': case 'fainted': return true;
      case 'not_hungry': case 'satiated': return false;
      default: return undefined;
    }
  }
  /** Visible creatures only, sorted by geometric distance then map coordinates. */
  sense(filter: entities = entities.Creature): readonly Entity[] {
    if (!this.game.observation.you) return [];
    return this.game.observation.world.filter(cell => {
      const actor = cell.occupant;
      if (!cell.visible || !actor || actor.kind === 'self') return false;
      switch (filter) {
        case entities.Creature: return true;
        case entities.Enemy: return actor.attitude === 'hostile';
        case entities.Ally: return actor.attitude === 'tame';
        case entities.Peaceful: return actor.attitude === 'peaceful';
        default: return actor.appearance === filter;
      }
    }).map(cell => new Entity(entityKey, this.game, cell))
      .sort((a, b) => a.distance - b.distance || a.position[1] - b.position[1] || a.position[0] - b.position[0]);
  }
  senseClosest(filter: entities = entities.Creature): Entity | undefined { return this.sense(filter)[0]; }
  /** Attempt ONE step in a direction or toward a freshly sensed entity. No pathfinding.
   * Normal engine bump behavior applies, including doors, attacks, and warnings. */
  go(target: direction | Entity): Promise<Snapshot> {
    const options = target instanceof Entity ? current(target, this.game) : { expectedRevision: this.state.revision };
    const heading = target instanceof Entity ? offsets.get(target.offset.map(Math.sign).join(',')) : target;
    if (!heading || !Object.values(direction).includes(heading)) throw Error('A compass direction or a distinct visible entity is required.');
    return this.game.move(heading, options);
  }
  /** Attempt one melee bump against a freshly perceived adjacent hostile creature.
   * Never force-attacks or confirms a warning. Inspect the returned outcome. */
  attack(target: Entity): Promise<Snapshot> {
    current(target, this.game);
    if (target.attitude !== 'hostile') throw Error('Attack requires a perceived hostile creature.');
    if (target.distance !== 1) throw Error('Melee attack requires an adjacent enemy.');
    return this.go(target);
  }
  wait(): Promise<Snapshot> { return this.game.wait({ expectedRevision: this.state.revision }); }
  search(): Promise<Snapshot> { return this.game.search({ expectedRevision: this.state.revision }); }
  climb(target: 'up' | 'down'): Promise<Snapshot> { return this.game.climb(target, { expectedRevision: this.state.revision }); }
}
