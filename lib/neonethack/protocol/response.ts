import type { Schema } from "./catalog.ts";
const string = { type: "string" };
const integer = { type: "integer" };
const boolean = { type: "boolean" };
const enumeration = (...values: string[]) => ({ type: "string", enum: values });
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({ type: "object", properties, required });
const array = (items: Schema): Schema => ({ type: "array", items });
const nullable = (s: Schema): Schema => ({ anyOf: [s, { type: "null" }] });
const selection = object({ min: integer, max: integer });
const item = object({ id: string, label: string, location: enumeration("inventory", "here"), quantity: integer, category: string, usage: array(enumeration("worn", "wielded", "offhand", "alternate", "quivered", "attached")) }, ["id", "label", "location", "quantity"]);
const end = object({ kind: enumeration("death", "ascended", "escaped", "quit", "disconnected", "engineError", "unknown"), cause: string, turn: integer }, ["kind", "turn"]);
const base = { id: string, action: string, about: string, cancellable: boolean };
const decision = (kind: string, properties: Record<string, Schema> = {}, optional: string[] = []) => object({ ...base, kind: { const: kind }, ...properties }, ["id", "action", "kind", "cancellable", ...Object.keys(properties).filter(k => !optional.includes(k))]);
const event = (type: string, properties: Record<string, Schema>) => object({ type: { const: type }, ...properties });
const observation = object({
  turn: integer, location: object({ id: string, depthLabel: string }),
  you: nullable(object({ x: integer, y: integer })),
  vitals: { type: "object", additionalProperties: { anyOf: [string, { type: "number" }, array(string)] } },
  inventory: array(item), inventoryKnown: boolean,
  here: object({ known: boolean, items: array(item) }),
  perception: object({ version: integer, inventory: enumeration("current", "lastKnown", "unknown"), here: enumeration("current", "lastKnown", "unknown"), equipment: enumeration("current", "lastKnown", "unknown") }),
  world: array(object({
    x: integer, y: integer,
    terrain: object({ type: string, knowledge: { const: "remembered" } }),
    occupant: object({ kind: enumeration("self", "creature", "ally"), mark: string, color: integer }, ["kind", "mark"]),
    objects: array(object({ mark: string, color: integer })),
  }, ["x", "y", "terrain"])), heard: array(string),
});
/** Responses are additive within v1. Clients replace observations, ignore
 * unknown properties, and fail closed on unknown decision kinds/outcomes. */
export const responseSchema: Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "libneonethack response v1",
  ...object({
    version: { const: 1 }, sessionId: string, requestId: nullable(string), revision: integer,
    outcome: object({ action: string, status: enumeration("completed", "needsChoice", "blocked", "cancelled", "interrupted", "unknown"), reason: string, turnsElapsed: integer, positionChanged: boolean, effects: array(string) }, ["action", "status", "turnsElapsed", "positionChanged", "effects"]),
    observation,
    decision: nullable({ oneOf: [
      decision("item", { options: array(item), selection }),
      decision("target", { allowedTargets: array(enumeration("self", "direction")) }),
      decision("confirmation"),
      decision("choice", { options: array(object({ id: integer, label: string })), selection }, ["selection"]),
      decision("text"),
    ] }),
    events: array({ oneOf: [
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
    capabilities: object({ persistence: enumeration("filesystem", "memory", "indexeddb"), durability: enumeration("fsync", "none", "indexeddb-transaction"), ownership: enumeration("process-lease", "isolated-worker", "origin-web-lock"), resume: enumeration("pinned-executable", "same-package"), runtimeProfile: { const: 1 } }, ["persistence", "durability", "ownership", "resume"]),
    catalog: object({ version: { const: 1 }, methods: array(object({ name: string, description: string, schema: { type: "object" } })) }),
  }, ["version"]),
  anyOf: [
    { required: ["sessionId", "requestId", "revision", "outcome", "observation", "events", "decision", "ended", "end"] },
    { required: ["error"] },
    { required: ["libraryVersion", "backend", "catalog", "capabilities"] },
  ],
};
