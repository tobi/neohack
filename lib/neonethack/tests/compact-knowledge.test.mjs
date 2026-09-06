import test from "node:test";
import assert from "node:assert/strict";
import { CompactResponses, CompactObservationReader } from "../dist/mcp/compact.js";

// knowledge carries observedTurn, which advances every ordinary turn; a delta
// must not re-send the whole block when only that marker moved.
const knowledge = (observedTurn, kills) => ({
  observedTurn,
  skills: [
    { id: "skill-1", name: "dagger", level: "Basic", advancement: "practice" },
    { id: "skill-17", name: "spear", level: "Basic", advancement: "practice" },
    { id: "skill-28", name: "attack spells", level: "Unskilled", advancement: "practice" },
  ],
  conduct: { kills, weaponHits: kills, food: 0, wishes: 0, pets: 1 },
  spells: [],
  levels: [{ branch: "The Dungeons of Doom", depth: 1, id: "level-0-1", freshness: "remembered", features: {} }],
  achievements: [],
});

const frame = (revision, turn, k) => ({
  version: 1, sessionId: "a", revision,
  observation: {
    location: { id: "level-0-1" },
    turn,
    you: { x: 5, y: 5 },
    vitals: { turn, health: 16 },
    knowledge: k,
    world: [{ x: 5, y: 5, terrain: { type: "floor" } }],
  },
});

test("ordinary deltas omit knowledge when only its observedTurn advanced", () => {
  const compact = new CompactResponses(), reader = new CompactObservationReader();
  reader.apply(compact.project(frame(1, 1, knowledge(1, 1)), "session.create"));
  const next = compact.project(frame(2, 2, knowledge(2, 1)), "game.move");
  assert.equal(next.update.kind, "delta");
  assert.equal(next.observation.knowledge, undefined, "static knowledge must not ride along the delta");
  const materialized = reader.apply(next);
  assert.equal(materialized.observation.turn, 2);
  assert.equal(materialized.observation.knowledge.observedTurn, 1, "baseline knowledge is retained");
  assert.equal(materialized.observation.knowledge.conduct.kills, 1);
});

test("deltas still disclose knowledge when its content changes", () => {
  const compact = new CompactResponses(), reader = new CompactObservationReader();
  reader.apply(compact.project(frame(1, 1, knowledge(1, 1)), "session.create"));
  const next = compact.project(frame(2, 2, knowledge(2, 2)), "game.move");
  assert.equal(next.update.kind, "delta");
  assert.deepEqual(next.observation.knowledge, knowledge(2, 2));
  const materialized = reader.apply(next);
  assert.equal(materialized.observation.knowledge.observedTurn, 2);
  assert.equal(materialized.observation.knowledge.conduct.kills, 2);
});

test("content changes after an omission are still disclosed and replace the baseline", () => {
  const compact = new CompactResponses(), reader = new CompactObservationReader();
  reader.apply(compact.project(frame(1, 1, knowledge(1, 1)), "session.create"));
  reader.apply(compact.project(frame(2, 2, knowledge(2, 1)), "game.move"));
  const next = compact.project(frame(3, 3, knowledge(3, 4)), "game.move");
  assert.deepEqual(next.observation.knowledge, knowledge(3, 4), "changed content must be emitted");
  const materialized = reader.apply(next);
  assert.equal(materialized.observation.knowledge.observedTurn, 3);
  assert.equal(materialized.observation.knowledge.conduct.kills, 4);
});
