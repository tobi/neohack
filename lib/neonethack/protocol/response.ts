import { catalog, compass, automaticPickup, type Schema } from "./catalog.ts";
export const hungerStates = ["satiated", "not_hungry", "hungry", "weak", "fainting", "fainted", "starved", "unknown"];
export const burdenStates = ["unencumbered", "burdened", "stressed", "strained", "overtaxed", "overloaded", "unknown"];
const string = { type: "string" };
const integer = { type: "integer" };
const boolean = { type: "boolean" };
const enumeration = (...values: string[]) => ({ type: "string", enum: values });
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({ type: "object", properties, required });
const array = (items: Schema): Schema => ({ type: "array", items });
const nullable = (s: Schema): Schema => ({ anyOf: [s, { type: "null" }] });
const selection = object({ min: integer, max: integer });
const item = object({ id: string, label: string, location: enumeration("inventory", "here"), quantity: integer, category: string, actions: array(enumeration("eat", "equip", "remove", "apply", "drink", "read", "zap", "wield", "drop", "throw", "offer", "dip", "rub", "invoke", "quiver", "pickup")), usage: array(enumeration("worn", "wielded", "offhand", "alternate", "quivered", "attached")) }, ["id", "label", "location", "quantity"]);
const lootItem = object({id: string, label: string, quantity: integer});
const knownProperties = object({identity: string, beatitude: enumeration("blessed", "uncursed", "cursed"), charges: integer, recharges: integer, enchantment: integer, erosionProof: boolean}, []);
item.properties.known = knownProperties;
const knowledge = object({
 observedTurn: integer,
 spells: array(object({id: string, name: string, level: integer, category: string, failurePercent: integer, retention: string})),
 skills: array(object({id: string, name: string, level: string, advancement: enumeration("available", "needsExperience", "peaked", "practice")})),
 levels: array(object({id: string, branch: string, depth: integer, freshness: {const: "remembered"}, annotation: string, features: object({fountains: integer, sinks: integer, altars: integer, thrones: integer, shops: integer, temples: integer})}, ["id", "branch", "depth", "freshness", "features"])),
 conduct: {type: "object", additionalProperties: integer},
 achievements: array(object({id: string, name: string})),
});
const end = object({ score: integer, kind: enumeration("death", "ascended", "escaped", "quit", "disconnected", "engineError", "unknown"), cause: string, turn: integer }, ["kind", "turn"]);
const base = { id: string, action: string, about: string, cancellable: boolean };
const decision = (kind: string, properties: Record<string, Schema> = {}, optional: string[] = []) => object({ ...base, kind: { const: kind }, ...properties }, ["id", "action", "kind", "cancellable", ...Object.keys(properties).filter(k => !optional.includes(k))]);
const event = (type: string, properties: Record<string, Schema>, optional: string[] = []) => object({ type: { const: type }, ...properties }, ["type", ...Object.keys(properties).filter(k => !optional.includes(k))]);
const closed = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({ ...object(properties, required), additionalProperties: false });
const basis = closed({ revision: integer, levelId: string, origin: closed({ x: integer, y: integer }) });
const inputGate = { oneOf: [closed({ state: enumeration("ready", "recoveryRequired", "ended", "unavailable") }), closed({ state: { const: "decision" }, decisionId: string })] };
const offerMethods = ["move", "open", "close", "kick", "apply", "search", "wait", "pickup", "climb", "eat", "drink", "wield", "equip", "remove", "read", "drop", "zap", "loot"];
const actionOffer = { oneOf: offerMethods.flatMap(action => {
  const method = catalog.methods.find(m => m.name === 'game.' + action)!;
  const properties = Object.fromEntries(Object.entries(method.schema.properties).filter(([k]) => !["sessionId", "requestId", "expectedRevision"].includes(k))) as Record<string, Schema>;
  const args = closed(properties, method.schema.required.filter((k: string) => k in properties));
  const common = { key: string, method: { const: method.name }, cost: { const: "variable" }, cautions: array(enumeration("mayInjure", "mayMakeNoise", "mayDamageProperty")), context: closed({ kind: { const: "door" }, x: integer, y: integer }) };
  const required = ["key", "method", "cost", "availability"];
  return [
    closed({ ...common, availability: enumeration("attemptable", "uncertain"), arguments: args, nextInput: enumeration("item") }, [...required, "arguments"]),
    closed({ ...common, availability: { const: "needsSelection" }, arguments: args, nextInput: enumeration("item") }, [...required, "arguments", "nextInput"]),
    closed({ ...common, availability: { const: "outOfReach" } }, required),
    closed({ ...common, availability: { const: "knownBlocked" }, reason: string }, [...required, "reason"]),
  ];
}) };
const cellActions = closed({
  x: integer, y: integer, dx: integer, dy: integer, inBounds: boolean, visible: nullable(boolean),
  terrain: closed({ type: string, freshness: enumeration("current", "remembered", "unknown"), orientation: enumeration("horizontal", "vertical") }, ["type", "freshness"]),
  door: closed({ lock: enumeration("locked", "unlocked", "unknown"), freshness: enumeration("witnessed", "remembered", "unknown"), observedTurn: integer }, ["lock", "freshness"]),
  occupant: closed({ kind: enumeration("self", "creature", "ally"), mark: string, color: integer, appearance: string, attitude: enumeration("hostile", "peaceful", "tame") }, ["kind"]),
  objects: array(closed({ mark: string, color: integer, kind: enumeration("boulder") }, ["mark", "color"])),
  hazards: array(enumeration("trap", "water", "lava")),
  walkable: nullable(boolean), movement: closed({ relation: enumeration("here", "adjacent", "distant"), intent: enumeration("step", "attemptOpen", "attemptObstacle", "creatureBump", "allyBump", "possiblePush", "unknown"), knownRestriction: enumeration("intactDoorDiagonal", "lockedDoor", "knownTerrainObstacle") }, ["relation"]),
  actions: { ...array(actionOffer), maxItems: 16 },
}, ["x", "y", "dx", "dy", "inBounds", "walkable", "movement", "actions"]);
const neighborhood = { oneOf: [
  closed({ version: { const: 1 }, status: { const: "available" }, basis, inputGate, radius: { const: 4 }, cells: { ...array(cellActions), minItems: 81, maxItems: 81 } }),
  closed({ version: { const: 1 }, status: { const: "unavailable" }, reason: enumeration("unknownPosition", "unsupportedPerception", "recoveryRequired") }),
] };
const observation = object({
  automaticPickup,
  knowledge,
  neighborhood,
  turn: integer, location: object({ id: string, depthLabel: string }),
  you: nullable(object({ x: integer, y: integer })),
  vitals: { type: "object", properties: { hunger: enumeration(...hungerStates), burden: enumeration(...burdenStates), hungerLabel: string, burdenLabel: string }, additionalProperties: { anyOf: [string, { type: "number" }, array(string)] } },
  inventory: array(item), inventoryKnown: boolean,
  here: object({ known: boolean, items: array(item) }),
  perception: object({ version: integer, inventory: enumeration("current", "lastKnown", "unknown"), here: enumeration("current", "lastKnown", "unknown"), equipment: enumeration("current", "lastKnown", "unknown"), knowledge: enumeration("current", "lastKnown", "unknown") }, ["version", "inventory", "here", "equipment"]),
  world: array(object({
    x: integer, y: integer, visible: boolean,
    terrain: object({ type: string, knowledge: { const: "remembered" }, freshness: enumeration("current", "remembered", "unknown"), orientation: enumeration("horizontal", "vertical") }, ["type", "knowledge"]),
    occupant: object({ kind: enumeration("self", "creature", "ally"), mark: string, color: integer, appearance: string, attitude: enumeration("hostile", "peaceful", "tame") }, ["kind", "mark"]),
    objects: array(object({ mark: string, color: integer, kind: enumeration("boulder") }, ["mark", "color"])),
  }, ["x", "y", "terrain"])), heard: array(string),
}, ["turn", "location", "you", "vitals", "inventory", "inventoryKnown", "here", "perception", "world", "heard"]);
/** Responses are additive within v1. Clients replace observations, ignore
 * unknown properties, and fail closed on unknown decision kinds/outcomes. */
export const responseSchema: Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "libneonethack response v1",
  ...object({
    kind: { const: "actions" }, basis, inputGate, cell: cellActions,
    version: { const: 1 }, sessionId: string, requestId: nullable(string), revision: integer,
    outcome: object({ action: string, status: enumeration("completed", "needsChoice", "blocked", "cancelled", "interrupted", "unknown"), reason: string, turnsElapsed: integer, positionChanged: boolean, effects: array(string) }, ["action", "status", "turnsElapsed", "positionChanged", "effects"]),
    observation,
    decision: nullable({ oneOf: [
      decision("item", { options: array(item), selection, counted: boolean }, ["counted"]),
      decision("target", { allowedTargets: array(enumeration("self", "direction")), allowedDirections: array(enumeration(...compass.enum, "up", "down")) }, ["allowedDirections"]),
      decision("confirmation", { context: object({ action: string, direction: enumeration("north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest", "up", "down"), itemId: string }, ["action"]) }, ["context"]),
      decision("choice", { options: array(object({ id: integer, label: string, transfer: enumeration("take", "put"), suggested: boolean }, ["id", "label"])), selection, containerPhase: enumeration("inspect", "transfer"), pickupReview: boolean }, ["selection", "containerPhase", "pickupReview"]),
      decision("text", { purpose: enumeration("consumedPotionNickname") }, ["purpose"]),
      decision("position", { cursor: closed({ x: integer, y: integer }), mode: enumeration("browse", "select") }),
    ] }),
    events: array({ oneOf: [
      event("itemLooted", {item: lootItem, quantity: integer, source: enumeration("floor", "container", "engulfer"), container: lootItem, turn: integer}, ["container"]),
      event("containerOpened", {container: lootItem, contents: array(lootItem), turn: integer}),
      event("doorWitness", { levelId: string, x: integer, y: integer, fact: enumeration("locked", "unlocked", "opened", "closed", "resisted", "notClosed"), turn: integer }),
      event("saw", { x: integer, y: integer, kind: string, mark: string, color: integer }),
      event("felt", { sense: string, value: string }), event("heard", { text: string }),
      event("shown", { about: string, items: array(string) }),
      event("actionResult", { action: string, status: enumeration("completed", "interrupted"), turn: integer }),
      event("lifeSaved", { cause: string, turn: integer, health: integer }),
      { ...end, properties: { ...end.properties, type: { const: "ended" } }, required: [...end.required, "type"] },
    ] }),
    ended: boolean, end: nullable(end),
    error: object({ code: string, message: string }),
    recording: object({ status: string }, ["status"]), storage: object({ status: string }, ["status"]),
    libraryVersion: string, backend: enumeration("native", "wasm"),
    capabilities: object({ affordanceVersion: { const: 1 }, persistence: enumeration("filesystem", "memory", "indexeddb"), durability: enumeration("fsync", "none", "indexeddb-transaction"), ownership: enumeration("process-lease", "isolated-worker", "origin-web-lock"), resume: enumeration("pinned-executable", "same-package"), runtimeProfile: { const: 1 } }, ["persistence", "durability", "ownership", "resume"]),
    catalog: object({ version: { const: 1 }, methods: array(object({ name: string, description: string, schema: { type: "object" } })) }),
  }, ["version"]),
  anyOf: [
    { required: ["kind", "sessionId", "basis", "inputGate", "cell"] },
    { required: ["sessionId", "requestId", "revision", "outcome", "observation", "events", "decision", "ended", "end"] },
    { required: ["error"] },
    { required: ["libraryVersion", "backend", "catalog", "capabilities"] },
  ],
};

/** MCP presentation envelope; full engine schema remains separate. */
export const compactResponseSchema: Schema = {
  type: "object", required: ["version"],
  properties: {
    version: { const: 1 }, sessionId: string, revision: integer,
    requestId: nullable(string), observation: { type: "object" },
    update: closed({ kind: enumeration("snapshot", "delta"), id: integer, base: integer,
      remove: array(string), worldRemoved: array({ type: "array", items: integer, minItems: 2, maxItems: 2 }) }, ["kind", "id"]),
    decision: nullable({ type: "object" }), events: array({ type: "object" }),
    outcome: { type: "object" }, ended: boolean, end: nullable({ type: "object" }),
    error: object({ code: string, message: string }),
  },
};
