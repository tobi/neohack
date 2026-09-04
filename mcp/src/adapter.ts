// Semantic adapter: the Explorer API (API_DESING.md) over the raw engine
// tracker in server.ts. The adapter owns intent resolution, operation
// tracking, typed decisions, outcomes, revisions, and full observations.
// NetHack's keyboard commands, inventory letters, modal prompts, and
// display pauses are handled inside this boundary and never leak.
//
// Layout: this file = types + observation builders (vitals, terrain,
// location). Actions live in actions.ts; decisions ride alongside
// operations. server.ts keeps the engine pump, tracked state, input log,
// and replay, and exposes primitives this module consumes.
import type { GameSession } from "./server";

// ---------------------------------------------------------------------------
// Public envelope types (v3)
// ---------------------------------------------------------------------------

export type ActionStatus =
  | "completed" | "needsChoice" | "blocked" | "cancelled" | "interrupted" | "unknown";

export interface Outcome {
  action: string;
  status: ActionStatus;
  reason?: string;
  turnsElapsed: number;
  positionChanged: boolean;
  effects: string[];
}

export interface Observation {
  turn: number;
  location: { id: string; depthLabel: string };
  you: { x: number; y: number } | null;
  vitals: Record<string, unknown>;
  inventory: ItemRef[];
  inventoryKnown: boolean;
  world: LayeredCell[];
}

export interface ItemRef {
  id: string;
  label: string;
  location: "inventory" | "here";
  quantity: number;
  /** Private engine slot (inventory letter). Never exposed on the wire. */
  letter?: string;
}

export interface LayeredCell {
  x: number;
  y: number;
  terrain: { type: string; knowledge: "remembered" };
  occupant?: { kind: "self" | "creature" | "ally"; mark: string; ref?: string };
  objects?: { mark: string; color: number }[];
}

export interface Decision {
  id: string;
  kind: "item" | "target" | "confirmation" | "choice" | "text";
  action: string;
  about?: string;
  cancellable: boolean;
  selection?: { min: number; max: number };
  options?: { id: string; label: string }[];
  allowedTargets?: string[];
}

export interface EndInfo {
  kind: "death" | "ascended" | "escaped" | "quit" | "disconnected" | "engineError" | "unknown";
  cause?: string;
  turn?: number;
}

export interface ActResponse {
  sessionId: string;
  requestId: string | null;
  revision: number;
  outcome: Outcome;
  observation: Observation;
  events: Record<string, unknown>[];
  decision: Decision | null;
  ended: boolean;
  end: EndInfo | null;
  error?: { code: string; message: string };
}

// ---------------------------------------------------------------------------
// Vitals: named senses with numbers where numbers are honest
// ---------------------------------------------------------------------------

const HUNGER: Record<string, string> = {
  "satiated": "satiated",
  "not hungry": "not_hungry",
  "hungry": "hungry",
  "weak": "weak",
  "fainting": "fainting",
  "fainted": "fainted",
};

const BURDEN: Record<string, string> = {
  "unencumbered": "unencumbered",
  "burdened": "burdened",
  "stressed": "stressed",
  "strained": "strained",
  "overtaxed": "overtaxed",
  "overloaded": "overloaded",
};

const NUMERIC_VITALS = new Set([
  "gold", "energy", "maxEnergy", "level", "armor", "turn",
  "health", "maxHealth", "experience",
]);

function numOrRaw(v: string): number | string {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && String(n) === v.trim() ? n : v;
}

/** Raw status map (design-adapter names from server.ts VITALS) to observation vitals. */
export function buildVitals(raw: Map<number, string>, names: Record<number, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [f, v] of raw) {
    const sense = names[f];
    if (!sense || sense === "version") continue; // engine bookkeeping, not world
    if (sense === "title" || sense === "alignment" || sense === "hand" ||
        sense === "wear" || sense === "ground" || sense === "strength" ||
        sense === "dexterity" || sense === "constitution" ||
        sense === "intelligence" || sense === "wisdom" || sense === "charisma" ||
        sense === "score" || sense === "depth") {
      out[sense] = sense === "depth" ? v.replace(/^Dlvl:/, "") : v;
    } else if (sense === "hunger") {
      out[sense] = HUNGER[v.toLowerCase()] ?? v.toLowerCase();
    } else if (sense === "burden") {
      out[sense] = BURDEN[v.toLowerCase()] ?? v.toLowerCase();
    } else if (sense === "condition") {
      out[sense] = v; // decoded to words by the caller (needs CONDITIONS table)
    } else if (NUMERIC_VITALS.has(sense)) {
      out[sense] = numOrRaw(v);
    } else {
      out[sense] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Terrain: perceived semantics from the visible sign (adapter knowledge,
// never asked of the client)
// ---------------------------------------------------------------------------

const TERRAIN_BY_MARK: Record<string, string> = {
  "-": "wall", "|": "wall",
  ".": "floor",
  "#": "corridor",
  "+": "closedDoor",
  "<": "stairsUp", ">": "stairsDown",
  "_": "altar", "{": "fountain", "\\": "throne",
  "^": "trap",
  " ": "dark",
};

export function terrainType(mark: string, color: number): string {
  if (mark === "}") {
    if (color === 1 || color === 9) return "lava";
    if (color === 4 || color === 12 || color === 14) return "water";
    return "sink";
  }
  if (mark === '"') {
    if (color === 2 || color === 3 || color === 10) return "grass";
    return "unknown";
  }
  return TERRAIN_BY_MARK[mark] ?? "unknown";
}

// ---------------------------------------------------------------------------
// Location: stable, deterministic level identity
// ---------------------------------------------------------------------------

/** Slug of the engine's level description; unique per branch+depth. */
export function locationOf(leveldesc: string): { id: string; depthLabel: string } {
  const depthLabel = leveldesc || "unknown";
  const id = "level-" + depthLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "level-unknown";
  return { id, depthLabel };
}

export function turnOf(s: GameSession): number {
  const t = parseInt(s.status.get(16) ?? "0", 10);
  return Number.isFinite(t) ? t : 0;
}

// ---------------------------------------------------------------------------
// Layered world: known terrain always; occupants/objects only as perceived
// ---------------------------------------------------------------------------

export interface RawCell {
  x: number; y: number; glyph: number; ch: number; color: number;
}

const CREATURE_LO = 0, ALLY_LO = 766, BODY_LO = 2299, OBJECT_LO = 3448;
const TERRAIN_LO = 3929, STRANGE_LO = 4051, EFFECT_LO = 7226;

function glyphBand(glyph: number): string {
  if (glyph < ALLY_LO) return "creature";
  if (glyph < 1532) return "ally";
  if (glyph < BODY_LO) return "creature";
  if (glyph < OBJECT_LO) return "remains";
  if (glyph < TERRAIN_LO) return "object";
  if (glyph < STRANGE_LO) return "terrain";
  if (glyph < EFFECT_LO) return "effect";
  return "object";
}

/**
 * Tracked cells + terrain memory to layered perception. Terrain comes
 * from memory (knowledge: remembered) and is never erased by an
 * occupant: standing on stairs keeps the stairs known. An occupant or
 * object entry means currently perceived. Effects are transient and
 * omitted. The explorer's own square always carries occupant self.
 */
export function layerWorld(
  cells: Map<string, RawCell>,
  terrainMem: Map<string, string>,
  you: { x: number; y: number } | null,
): LayeredCell[] {
  const out: LayeredCell[] = [];
  for (const c of cells.values()) {
    if (!c.glyph && !c.ch) continue;
    const mark = String.fromCharCode(c.ch);
    const band = glyphBand(c.glyph);
    if (band === "effect") continue;
    const key = `${c.x},${c.y}`;
    const remembered = terrainMem.get(key);
    const cell: LayeredCell = {
      x: c.x, y: c.y,
      terrain: {
        type: band === "terrain" ? terrainType(mark, c.color) : (remembered ?? "unknown"),
        knowledge: "remembered",
      },
    };
    const isYou = !!you && c.x === you.x && c.y === you.y;
    if (isYou) {
      cell.occupant = { kind: "self", mark };
    } else if (band === "creature" || band === "ally") {
      cell.occupant = { kind: band, mark };
    } else if (band === "remains" || band === "object") {
      cell.objects = [{ mark, color: c.color }];
    }
    out.push(cell);
  }
  out.sort((a, b) => a.y - b.y || a.x - b.x);
  return out;
}

// ---------------------------------------------------------------------------
// Revision + idempotency sidecar (persisted next to the input log)
// ---------------------------------------------------------------------------

export interface RequestRecord {
  argsKey: string;
  result: ActResponse;
}

export interface OperationState {
  action: string;
  args: Record<string, unknown>;
  phase: string;
  decisionId: string | null;
}

export interface Sidecar {
  revision: number;
  requests: Record<string, RequestRecord>;
  operation: OperationState | null;
  inventoryRev: number;
}

export function emptySidecar(): Sidecar {
  return { revision: 0, requests: {}, operation: null, inventoryRev: -1 };
}

export function argsKey(args: Record<string, unknown>): string {
  const { sessionId: _s, requestId: _r, expectedRevision: _e, ...rest } = args;
  return JSON.stringify(rest);
}
