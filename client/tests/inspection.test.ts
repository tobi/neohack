import { expect, test } from "bun:test";
import { inspectionData, freshness } from "../inspection.js";
const base = (): any => ({
  turn: 4,
  you: { x: 2, y: 3 },
  location: { id: "level-1" },
  world: [
    {
      x: 2,
      y: 3,
      terrain: { type: "stairsDown", knowledge: "remembered" },
      occupant: { kind: "self", mark: "@" },
    },
  ],
  inventory: [],
  inventoryKnown: true,
  here: { known: true, items: [] },
});

test("inspection preserves zero/exceptional vitals and distinguishes missing conditions", () => {
  const o = {
    ...base(),
    vitals: { health: 0, maxHealth: 18, armor: -2, strength: "18/02", gold: 0 },
  };
  const d = inspectionData(o, "self");
  expect(d.rows).toContainEqual(["Health", "0 / 18"]);
  expect(d.rows).toContainEqual(["Armor class", "-2"]);
  expect(d.rows).toContainEqual(["Strength", "18/02"]);
  expect(d.rows).toContainEqual(["Gold", "0"]);
  expect(d.conditions).toBeNull();
  expect(
    inspectionData({ ...o, vitals: { health: null, energy: null } }, "self")
      .rows,
  ).toContainEqual(["Health", "Not reported"]);
  expect(
    inspectionData({ ...o, vitals: { ...o.vitals, condition: [] } }, "self")
      .conditions,
  ).toEqual([]);
});
test("equipment is never inferred from item names or old recordings", () => {
  const o = {
    ...base(),
    inventory: [{ id: "x", label: "a shield (being worn)" }],
  };
  expect(inspectionData(o, "self").equipmentKnown).toBe(false);
  expect(inspectionData(o, "self").equipment).toEqual([]);
  const reported = {
    ...o,
    perception: { equipment: "current" },
    inventory: [
      { id: "x", label: "shield", usage: ["worn"] },
      { id: "y", label: "ration", usage: [] },
    ],
  };
  expect(inspectionData(reported, "self").equipment).toEqual([
    reported.inventory[0],
  ]);
  expect(
    inspectionData({ ...reported, inventoryKnown: false }, "self")
      .equipmentKnown,
  ).toBe(false);
});
test("unknown floor contents are not empty and cannot expose contradictory item data", () => {
  const o = base();
  o.here = { known: false, items: [{ label: "must not be shown" }] };
  const d = inspectionData(o, "here");
  expect(d.known).toBe(false);
  expect(d.items).toEqual([]);
  expect(d.notice).toContain("does not mean");
  const empty = inspectionData(base(), "here");
  expect(empty.known).toBe(true);
  expect(empty.items).toEqual([]);
});
test("here follows the explorer while tile inspection uses only the selected frame", () => {
  const o = base();
  o.here.items = [{ label: "ration" }];
  const before = JSON.stringify(o);
  expect(inspectionData(o, "here").items[0].label).toBe("ration");
  const remote = inspectionData(o, {
    x: 4,
    y: 4,
    terrain: { type: "altar" },
    objects: [{ label: "future treasure" }],
  });
  expect(remote.notice).toContain("not present");
  expect(remote.items).toEqual([]);
  expect(remote.rows).toContainEqual(["Terrain", "Not observed"]);
  expect(JSON.stringify(o)).toBe(before);
  const moved = {
    ...o,
    you: { x: 5, y: 6 },
    here: { known: true, items: [] },
    world: [{ x: 5, y: 6, terrain: { type: "floor" } }],
  };
  expect(inspectionData(moved, "here").context).toBe("5, 6");
  expect(inspectionData(moved, { x: 2, y: 3 }).notice).toContain("not present");
});
test("remote sightings are not full floor stacks and freshness is explicit", () => {
  const o = base();
  o.world.push({
    x: 3,
    y: 3,
    terrain: { type: "floor" },
    objects: [{ mark: "%" }],
  });
  const d = inspectionData(o, { x: 3, y: 3 });
  expect(d.here).toBe(false);
  expect(d.sightings).toEqual([{ mark: "%" }]);
  expect(d.items).toEqual([]);
  expect(d.notice).toContain("Only map sightings");
  expect(freshness("lastKnown")).toContain("may have changed");
  expect(freshness(undefined)).toBe("Freshness not recorded");
  expect(freshness("current")).toBe("Current at this boundary");
});
