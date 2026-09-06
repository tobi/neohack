import type { MethodParams } from "./requests.js";
export type { Method, MethodParams, Request } from "./requests.js";
export type Identity = MethodParams["session.create"];
export type Compass = MethodParams["game.move"]["direction"];
export type Direction = Compass | "up" | "down";
export type Item = NonNullable<MethodParams["game.eat"]["item"]>;
export type Target = NonNullable<MethodParams["game.zap"]["target"]>;
export type Answer = MethodParams["decision.answer"]["answer"];
export type ActionTarget = MethodParams["session.actions"]["target"];
export interface ActionBasis { revision: number; levelId: string; origin: { x: number; y: number } }
export type InputGate = { state: "ready" | "recoveryRequired" | "ended" | "unavailable" } | { state: "decision"; decisionId: string };
type OfferMethod = "game.move" | "game.open" | "game.close" | "game.kick" | "game.apply" | "game.search" | "game.wait" | "game.pickup" | "game.climb" | "game.eat" | "game.drink" | "game.wield" | "game.equip" | "game.remove" | "game.read" | "game.drop" | "game.zap";
type OfferArguments<M extends OfferMethod> = Omit<MethodParams[M], "sessionId" | "requestId" | "expectedRevision">;
export type ActionOffer = { [M in OfferMethod]: {
  key: string; method: M; cost: "variable";
  cautions?: ("mayInjure" | "mayMakeNoise" | "mayDamageProperty")[];
  context?: { kind: "door"; x: number; y: number };
} & (
  | { availability: "attemptable" | "uncertain"; arguments: OfferArguments<M>; nextInput?: "item" }
  | { availability: "needsSelection"; arguments: OfferArguments<M>; nextInput: "item" }
  | { availability: "outOfReach"; arguments?: never }
  | { availability: "knownBlocked"; reason: string; arguments?: never }
) }[OfferMethod];
export interface CellActions {
  x: number; y: number; dx: number; dy: number; inBounds: boolean;
  visible?: boolean | null;
  terrain?: { type: string; freshness: "current" | "remembered" | "unknown"; orientation?: "horizontal" | "vertical" };
  door?: { lock: "locked" | "unlocked" | "unknown"; freshness: "witnessed" | "remembered" | "unknown"; observedTurn?: number };
  occupant?: { kind: "self" | "creature" | "ally" };
  hazards?: ("trap" | "water" | "lava")[];
  walkable: boolean | null;
  movement: { relation: "here" | "adjacent" | "distant"; intent?: "step" | "attemptOpen" | "attemptObstacle" | "creatureBump" | "allyBump" | "possiblePush" | "unknown"; knownRestriction?: "intactDoorDiagonal" | "lockedDoor" | "knownTerrainObstacle" };
  actions: ActionOffer[];
}
export type Neighborhood =
  | { version: 1; status: "available"; basis: ActionBasis; radius: 4; inputGate: InputGate; cells: CellActions[] }
  | { version: 1; status: "unavailable"; reason: "unknownPosition" | "unsupportedPerception" | "recoveryRequired" };
export interface ActionsResponse { version: 1; kind: "actions"; sessionId: string; basis: ActionBasis; inputGate: InputGate; cell: CellActions }
export type Freshness = "current" | "lastKnown" | "unknown";
export interface ItemRef {
  id: string; label: string; location: "inventory" | "here";
  quantity: number; category: string;
  /** Candidate actions from the C resolver; absent when perception is stale. Not safety guarantees. */
  actions?: ("eat" | "equip" | "remove" | "apply" | "drink" | "read" | "zap" | "wield" | "drop" | "pickup")[];
  usage?: ("worn" | "wielded" | "offhand" | "alternate" | "quivered" | "attached")[];
}
export interface Cell {
  x: number; y: number;
  /** Engine sight at this boundary. Omitted by older engine packages. */
  visible?: boolean;
  terrain: { type: string; knowledge: "remembered"; orientation?: "horizontal" | "vertical" };
  occupant?: { kind: "self" | "creature" | "ally"; mark: string; color?: number; appearance?: string };
  objects?: { mark: string; color: number }[];
}
/** Omitted facts are unknown; empty known lists really are empty. */
export interface Observation {
  turn: number;
  location: { id: string; depthLabel: string };
  you: { x: number; y: number } | null;
  vitals: {
    health?: number | string; maxHealth?: number | string;
    energy?: number | string; maxEnergy?: number | string;
    armor?: number | string; gold?: number | string; level?: number | string;
    strength?: string; hunger?: string; burden?: string; condition?: string[] | string;
    [sense: string]: string | number | string[] | undefined;
  };
  inventory: ItemRef[]; inventoryKnown: boolean;
  here: { known: boolean; items: ItemRef[] };
  perception: { version: number; inventory: Freshness; here: Freshness; equipment: Freshness };
  /** Absent on historical receipts and older packages. */
  neighborhood?: Neighborhood;
  world: Cell[]; heard: string[];
}
interface DecisionBase { id: string; action: string; about?: string; cancellable: boolean }
export type Decision = DecisionBase & (
  | { kind: "item"; options: Omit<ItemRef, "category" | "usage">[]; selection: { min: number; max: number } }
  | { kind: "target"; allowedTargets: ("self" | "direction")[] }
  | { kind: "confirmation" }
  | { kind: "choice"; options: { id: number; label: string }[]; selection?: { min: number; max: number } }
  | { kind: "position"; cursor: { x: number; y: number }; mode: "browse" | "select" }
  | { kind: "text" }
);
export interface Outcome {
  action: string;
  status: "completed" | "needsChoice" | "blocked" | "cancelled" | "interrupted" | "unknown";
  reason?: string; turnsElapsed: number; positionChanged: boolean; effects: string[];
}
export interface End { kind: "death" | "ascended" | "escaped" | "quit" | "disconnected" | "engineError" | "unknown"; cause?: string; turn: number }
export type WorldEvent =
  | { type: "doorWitness"; levelId: string; x: number; y: number; fact: "locked" | "unlocked" | "opened" | "closed" | "resisted" | "notClosed"; turn: number }
  | { type: "saw"; x: number; y: number; kind: string; mark: string; color: number }
  | { type: "felt"; sense: string; value: string }
  | { type: "heard"; text: string }
  | { type: "shown"; about: string; items: string[] }
  | { type: "actionResult"; action: string; status: string; turn: number }
  | { type: "lifeSaved"; cause: string; turn: number; health: number }
  | ({ type: "ended" } & End);
export interface Diagnostic { status: string; message?: string; requiresResume?: boolean; [key: string]: unknown }
export interface ProtocolError { code: string; message: string }
export interface Snapshot {
  version: 1; sessionId: string; requestId: string | null; revision: number;
  outcome: Outcome; observation: Observation; events: WorldEvent[];
  decision: Decision | null; ended: boolean; end: End | null;
  error?: ProtocolError; recording?: Diagnostic; storage?: Diagnostic;
}
export interface Rejection { version: 1; error: ProtocolError; sessionId?: string; requestId?: string | null }
export interface Description {
  version: 1; libraryVersion: string; backend: "native" | "wasm";
  capabilities: {
    persistence: "filesystem" | "memory" | "indexeddb";
    durability: "fsync" | "none" | "indexeddb-transaction";
    ownership: "process-lease" | "isolated-worker" | "origin-web-lock";
    resume: "pinned-executable" | "same-package";
    /** Absent on older libraries: do not infer runtime isolation. */
    runtimeProfile?: 1;
    affordanceVersion?: 1;
  };
  catalog: { version: 1; methods: { name: string; description: string; schema: Record<string, unknown>; readOnly?: boolean; idempotent?: boolean }[] };
}
export type Response = Snapshot | Rejection | Description | ActionsResponse;
