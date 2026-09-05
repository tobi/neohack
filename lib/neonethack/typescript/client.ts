import type { Answer, Compass, Description, Identity, Item, Method, MethodParams, Request, Response, Snapshot, Target } from "./types.js";
export type { Answer, Compass, Description, Identity, Item, Method, MethodParams, Request, Response, Snapshot, Target } from "./types.js";

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
  private readonly requestId: () => string;
  constructor(transport: Transport, options: { requestId?: () => string } = {}) {
    this.transport = transport; this.requestId = options.requestId ?? (() => globalThis.crypto.randomUUID());
  }
  /** Low-level, fully typed versioned protocol. No automatic retries. */
  request<M extends Method>(method: M, params: MethodParams[M]): Promise<Response> {
    return this.transport.send({ version: 1, method, params } as Request);
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
  get state(): Snapshot { return this.current; }
  get observation() { return this.current.observation; }
  get decision() { return this.current.decision; }
  /** Exact, immutable operation retained after a transport failure. */
  get pendingRequest(): Request | null { return this.unresolved; }
  private enqueue<T>(f: () => Promise<T>): Promise<T> {
    const run = this.tail.then(f);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
  private accept(r: Response): Snapshot {
    if (isSnapshot(r) && r.revision >= this.current.revision) this.current = freeze(r);
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
  private operation<M extends GameMethod>(method: M, args: Arguments<M>): Promise<Snapshot> {
    // Copy inputs at invocation; caller mutation while queued cannot change intent.
    const copy = structuredClone(args);
    return this.enqueue(async () => {
      if (this.retired) throw Error("Session is closed; resume it explicitly.");
      if (this.unresolved) throw new UncertainExecution(this.unresolved);
      if (this.current.ended) throw Error("The game has ended.");
      if ([this.current.storage, this.current.recording].some(d => d && d.status !== "ok")) throw Error("Storage needs recovery before another operation.");
      const request = freeze({ version: 1, method, params: { ...copy, sessionId: this.id, requestId: this.requestId(), expectedRevision: this.current.revision } } as Request);
      return this.send(request);
    });
  }
  /** Retrieve the same receipt. A returned old frame never rewinds state. */
  retry(): Promise<Snapshot> {
    return this.enqueue(async () => {
      if (!this.unresolved) throw Error("No uncertain request to retry.");
      return this.send(this.unresolved);
    });
  }
  observe(): Promise<Snapshot> {
    return this.enqueue(async () => this.accept(await this.client.request("session.observe", { sessionId: this.id })));
  }
  close(): Promise<Snapshot> {
    return this.enqueue(async () => {
      const r = this.accept(await this.client.request("session.close", { sessionId: this.id }));
      this.retired = true;
      return r;
    });
  }
  move(direction: Compass) { return this.operation("game.move", { direction }); }
  wait() { return this.operation("game.wait", {}); }
  climb(direction: "up" | "down") { return this.operation("game.climb", { direction }); }
  search() { return this.operation("game.search", {}); }
  pray() { return this.operation("game.pray", {}); }
  kick(direction?: Compass) { return this.operation("game.kick", direction ? { target: { direction } } : {}); }
  open(direction?: Compass) { return this.operation("game.open", direction ? { target: { direction } } : {}); }
  closeDoor(direction?: Compass) { return this.operation("game.close", direction ? { target: { direction } } : {}); }
  pickup(item?: Item) { return this.operation("game.pickup", item === undefined ? {} : { item }); }
  eat(item?: Item) { return this.operation("game.eat", item === undefined ? {} : { item }); }
  drink(item?: Item) { return this.operation("game.drink", item === undefined ? {} : { item }); }
  wield(item?: Item) { return this.operation("game.wield", item === undefined ? {} : { item }); }
  equip(item?: Item) { return this.operation("game.equip", item === undefined ? {} : { item }); }
  remove(item?: Item) { return this.operation("game.remove", item === undefined ? {} : { item }); }
  read(item?: Item) { return this.operation("game.read", item === undefined ? {} : { item }); }
  apply(item?: Item) { return this.operation("game.apply", item === undefined ? {} : { item }); }
  drop(item?: Item) { return this.operation("game.drop", item === undefined ? {} : { item }); }
  zap(item?: Item, target?: Target) { return this.operation("game.zap", { ...(item === undefined ? {} : { item }), ...(target === undefined ? {} : { target }) }); }
  answer(decisionId: string, answer: Answer) { return this.operation("decision.answer", { decisionId, answer }); }
  cancel(decisionId: string) { return this.operation("decision.cancel", { decisionId }); }
}
