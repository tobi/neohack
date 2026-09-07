import { LowLevel } from './low.js';
import { Navigator, type GoOptions } from './navigator.js';
import { beforeInput, accepted, scheduled } from './lifecycle.js';
import type { LoreResponse, NavigationResponse, RouteResponse, AutomaticPickup, ActionTarget, ActionsResponse, Answer, Compass, Description, Identity, Item, Method, MethodParams, Request, Response, Snapshot, Target } from "./types.js";
export type { LoreResponse, NavigationResponse, RouteResponse, EquipmentSlot, ItemRef, AutomaticPickup, ActionTarget, ActionsResponse, ActionOffer, ActionBasis, CellActions, Neighborhood, InputGate, Answer, Compass, Description, Identity, Item, Method, MethodParams, Request, Response, Snapshot, Target } from "./types.js";

/** A transport owns its runtime, not game semantics. It must not retry input. */
export interface Transport {
  send(request: Request): Promise<Response>;
  close(): Promise<void>;
}
export class WorldError extends Error {
  readonly response: Response;
  constructor(response: Response) {
    super("error" in response && response.error ? `${response.error.code}: ${response.error.message}` : "Expected a game observation");
    this.name = "WorldError"; this.response = response;
  }
}
export class UncertainExecution extends Error {
  readonly request: Request;
  constructor(request: Request, cause?: unknown) {
    super("The operation may have executed. Retry this exact request, not a new operation.", { cause });
    this.name = "UncertainExecution"; this.request = request;
  }
}
export function isSnapshot(r: Response): r is Snapshot { return "observation" in r; }
function snapshot(r: Response): Snapshot {
  if ("error" in r && r.error || !isSnapshot(r)) throw new WorldError(r);
  return r;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) freeze(v);
    Object.freeze(value);
  }
  return value;
}
export class Neonethack {
  readonly transport: Transport;
  readonly low: LowLevel;
  private readonly requestId: () => string;
  constructor(transport: Transport, options: { requestId?: () => string } = {}) {
    this.low = new LowLevel(transport);
    this.transport = transport; this.requestId = options.requestId ?? (() => globalThis.crypto.randomUUID());
  }
  /** Low-level, fully typed versioned protocol. No automatic retries. */
  request<M extends Method>(method: M, params: MethodParams[M]): Promise<Response> {
    return this.low.request(method, params);
  }
  async describe(): Promise<Description> {
    const r = await this.request("protocol.describe", {});
    if (!("catalog" in r)) throw new WorldError(r);
    return r;
  }
  async create(identity: Identity = {}): Promise<Game> {
    return new Game(this, snapshot(await this.request("session.create", identity)), this.requestId);
  }
  async resume(sessionId: string): Promise<Game> {
    return new Game(this, snapshot(await this.request("session.resume", { sessionId })), this.requestId);
  }
  /** Retire all owned engines; never deletes stored games. */
  close(): Promise<void> { return this.transport.close(); }
}

export interface RevisionOptions { expectedRevision?: number }

type GameMethod = Extract<Method, `game.${string}` | `decision.${string}`>;
type Arguments<M extends GameMethod> = Omit<MethodParams[M], "sessionId" | "requestId" | "expectedRevision">;

/** One serialized live game. Each operation returns a complete immutable frame.
 * Never automatically confirms, repeats, walks, resumes an occupation or retries.
 */
export class Game {
  readonly id: string;
  private readonly client: Neonethack;
  private readonly requestId: () => string;
  private current: Snapshot;
  private tail: Promise<unknown> = Promise.resolve();
  private unresolved: Request | null = null;
  private retired = false;
  constructor(client: Neonethack, initial: Snapshot, requestId: () => string) {
    this.id = initial.sessionId; this.client = client; this.current = freeze(initial); this.requestId = requestId;
  }
  /** Exact tools; callers own revisions and receipts when bypassing Game. */
  get low(): LowLevel { return this.client.low; }
  get state(): Snapshot { return this.current; }
  get observation() { return this.current.observation; }
  get decision() { return this.current.decision; }
  /** Exact, immutable operation retained after a transport failure. */
  get pendingRequest(): Request | null { return this.unresolved; }
  private enqueue<T>(f: () => Promise<T>): Promise<T> {
    const run = this.tail.then(f);
    this.tail = run.then(() => undefined, () => undefined);
    scheduled(this, run);
    return run;
  }
  private accept(r: Response, notify = true): Snapshot {
    if (isSnapshot(r) && r.revision >= this.current.revision) { this.current = freeze(r); if (notify) accepted(this, this.current); }
    return snapshot(r);
  }
  private async send(request: Request): Promise<Snapshot> {
    this.unresolved = request;
    let response: Response;
    try { response = await this.client.transport.send(request); }
    catch (cause) { throw new UncertainExecution(request, cause); }
    // An explicit unknown result is not permission to generate another ID.
    if (!(isSnapshot(response) && response.outcome.status === "unknown") && !("error" in response && response.error?.code === "incompleteRequest")) this.unresolved = null;
    return this.accept(response);
  }
  private operation<M extends GameMethod>(method: M, args: Arguments<M>, options: RevisionOptions = {}): Promise<Snapshot> {
    beforeInput(this);
    // Copy inputs at invocation; caller mutation while queued cannot change intent.
    const copy = structuredClone(args);
    const expectedRevision = options.expectedRevision;
    return this.enqueue(async () => {
      if (this.retired) throw Error("Session is closed; resume it explicitly.");
      if (this.unresolved) throw new UncertainExecution(this.unresolved);
      if (this.current.ended) throw Error("The game has ended.");
      if ([this.current.storage, this.current.recording].some(d => d && d.status !== "ok")) throw Error("Storage needs recovery before another operation.");
      const request = freeze({ version: 1, method, params: { ...copy, sessionId: this.id, requestId: this.requestId(), expectedRevision: expectedRevision ?? this.current.revision } } as Request);
      return this.send(request);
    });
  }
  /** Retrieve the same receipt. A returned old frame never rewinds state. */
  retry(): Promise<Snapshot> {
    beforeInput(this);
    return this.enqueue(async () => {
      if (!this.unresolved) throw Error("No uncertain request to retry.");
      return this.send(this.unresolved);
    });
  }
  /** Pure query: never accepts a snapshot or resolves an uncertain operation. */
  actions(target: ActionTarget, options: RevisionOptions = {}): Promise<ActionsResponse> {
    const copy = structuredClone(target), expectedRevision = options.expectedRevision ?? this.current.revision;
    return this.enqueue(async () => {
      if (this.retired) throw Error("Session is closed; resume it explicitly.");
      if (this.unresolved) throw new UncertainExecution(this.unresolved);
      const r = await this.client.request("session.actions", { sessionId: this.id, expectedRevision, target: copy });
      if (!("kind" in r) || r.kind !== "actions" || "error" in r) throw new WorldError(r);
      return freeze(r);
    });
  }
  go(options: GoOptions) { return new Navigator(this).go(options); }
  lookup(name:string):Promise<LoreResponse> {
    return this.enqueue(async()=>{
      if(this.retired) throw Error("Session is closed; resume it explicitly.");
      const r=await this.client.request("session.lookup",{sessionId:this.id,name});
      if (!("kind" in r) || r.kind!=="lore" || "error" in r) throw new WorldError(r);
      return freeze(r);
    });
  }
  navigation(options: RevisionOptions = {}): Promise<NavigationResponse> {
    const expectedRevision = options.expectedRevision ?? this.current.revision;
    return this.enqueue(async () => {
      if (this.retired) throw Error("Session is closed; resume it explicitly.");
      if (this.unresolved) throw new UncertainExecution(this.unresolved);
      const r = await this.client.request("session.navigation", {sessionId:this.id,expectedRevision});
      if (!("kind" in r) || r.kind !== "navigation" || "error" in r) throw new WorldError(r);
      return freeze(r);
    });
  }
  /** Optional perception-only planner. Does not move or accept a new snapshot. */
  route(to: MethodParams["session.route"]["to"], options: RevisionOptions = {}): Promise<RouteResponse> {
    const copy = structuredClone(to), expectedRevision = options.expectedRevision ?? this.current.revision;
    return this.enqueue(async () => {
      if (this.retired) throw Error("Session is closed; resume it explicitly.");
      if (this.unresolved) throw new UncertainExecution(this.unresolved);
      const r = await this.client.request("session.route", { sessionId: this.id, expectedRevision, to: copy });
      if (!("kind" in r) || r.kind !== "route" || "error" in r) throw new WorldError(r);
      return freeze(r);
    });
  }
  observe(): Promise<Snapshot> {
    return this.enqueue(async () => this.accept(await this.client.request("session.observe", { sessionId: this.id }), false));
  }
  close(): Promise<Snapshot> {
    beforeInput(this);
    return this.enqueue(async () => {
      const r = this.accept(await this.client.request("session.close", { sessionId: this.id }));
      this.retired = true;
      return r;
    });
  }
  move(direction: Compass, options: RevisionOptions = {}) { return this.operation("game.move", { direction }, options); }
  wait(options: RevisionOptions = {}) { return this.operation("game.wait", {}, options); }
  climb(direction: "up" | "down", options: RevisionOptions = {}) { return this.operation("game.climb", { direction }, options); }
  search(options: RevisionOptions & {turns?:number} = {}) { const {turns,...guard}=options; return this.operation("game.search", turns===undefined?{}:{turns}, guard); }
  rest(options: RevisionOptions & {turns?:number} = {}) { const {turns,...guard}=options; return this.operation("game.rest", turns===undefined?{}:{turns}, guard); }
  quit(options: RevisionOptions = {}) { return this.operation("game.quit", {}, options); }
  loot(options: RevisionOptions = {}) { return this.operation("game.loot", {}, options); }
  configurePickup(automaticPickup: AutomaticPickup, options: RevisionOptions = {}) { return this.operation("game.configurePickup", { automaticPickup }, options); }
  pray(options: RevisionOptions = {}) { return this.operation("game.pray", {}, options); }
  kick(direction?: Compass, options: RevisionOptions = {}) { return this.operation("game.kick", direction ? { target: { direction } } : {}, options); }
  open(direction?: Compass, options: RevisionOptions = {}) { return this.operation("game.open", direction ? { target: { direction } } : {}, options); }
  closeDoor(direction?: Compass, options: RevisionOptions = {}) { return this.operation("game.close", direction ? { target: { direction } } : {}, options); }
  pickup(item?: Item, options: RevisionOptions = {}) { return this.operation("game.pickup", item === undefined ? {} : { item }, options); }
  eat(item?: Item, options: RevisionOptions = {}) { return this.operation("game.eat", item === undefined ? {} : { item }, options); }
  drink(item?: Item, options: RevisionOptions = {}) { return this.operation("game.drink", item === undefined ? {} : { item }, options); }
  wield(item?: Item, options: RevisionOptions = {}) { return this.operation("game.wield", item === undefined ? {} : { item }, options); }
  equip(item?: Item, options: RevisionOptions & { slot?: import("./equipment.js").EquipmentSlot } = {}) { return this.operation("game.equip", { ...(item === undefined ? {} : { item }), ...(options.slot ? {slot: options.slot} : {}) }, options); }
  remove(item?: Item, options: RevisionOptions = {}) { return this.operation("game.remove", item === undefined ? {} : { item }, options); }
  read(item?: Item, options: RevisionOptions = {}) { return this.operation("game.read", item === undefined ? {} : { item }, options); }
  apply(item?: Item, options: RevisionOptions = {}) { return this.operation("game.apply", item === undefined ? {} : { item }, options); }
  drop(item?: Item, options: RevisionOptions = {}) { return this.operation("game.drop", item === undefined ? {} : { item }, options); }
  cast(options: RevisionOptions = {}) { return this.operation("game.cast", {}, options); }
  enhance(options: RevisionOptions = {}) { return this.operation("game.enhance", {}, options); }
  swap(options: RevisionOptions = {}) { return this.operation("game.swap", {}, options); }
  twoWeapon(options: RevisionOptions = {}) { return this.operation("game.twoWeapon", {}, options); }
  pay(options: RevisionOptions = {}) { return this.operation("game.pay", {}, options); }
  engrave(options: RevisionOptions = {}) { return this.operation("game.engrave", {}, options); }
  fire(target?: Target, options: RevisionOptions = {}) { return this.operation("game.fire", target ? {target} : {}, options); }
  chat(direction?: Compass, options: RevisionOptions = {}) { return this.operation("game.chat", direction ? {target:{direction}} : {}, options); }
  attack(direction: Compass, options: RevisionOptions = {}) { return this.operation("game.attack", {direction}, options); }
  moveWithoutAttack(direction: Compass, options: RevisionOptions = {}) { return this.operation("game.moveWithoutAttack", {direction}, options); }
  dip(item?: Item, options: RevisionOptions = {}) { return this.operation("game.dip", item === undefined ? {} : {item}, options); }
  rub(item?: Item, options: RevisionOptions = {}) { return this.operation("game.rub", item === undefined ? {} : {item}, options); }
  invoke(item?: Item, options: RevisionOptions = {}) { return this.operation("game.invoke", item === undefined ? {} : {item}, options); }
  quiver(item?: Item, options: RevisionOptions = {}) { return this.operation("game.quiver", item === undefined ? {} : {item}, options); }
  offer(item?: Item, options: RevisionOptions = {}) { return this.operation("game.offer", item === undefined ? {} : { item }, options); }
  throw(item?: Item, target?: Target, options: RevisionOptions = {}) { return this.operation("game.throw", { ...(item === undefined ? {} : { item }), ...(target === undefined ? {} : { target }) }, options); }
  zap(item?: Item, target?: Target, options: RevisionOptions = {}) { return this.operation("game.zap", { ...(item === undefined ? {} : { item }), ...(target === undefined ? {} : { target }) }, options); }
  answer(decisionId: string, answer: Answer, options: RevisionOptions = {}) { return this.operation("decision.answer", { decisionId, answer }, options); }
  cancel(decisionId: string, options: RevisionOptions = {}) { return this.operation("decision.cancel", { decisionId }, options); }
}

export { Hero, Entity, Inventory, InventoryItem, defineBot, runBot, direction, entities } from './hero.js';
export type { BotContext, BotDefinition, BotBuilder, BotHandler, Step } from './hero.js';

export type { HeroEvent, HeroEventName, HeroEventDetails, HeroListener, BotResult, StopReason, CellChange, ItemSighting } from './hero-events.js';

export type { ScriptState, ScriptValue, ScriptResult, ScriptHost, ScriptControl, ScriptJournalEntry } from './script.js';
export { Navigator, type NavigationOptions, type NavigationResult, type GoOptions } from './navigator.js';
