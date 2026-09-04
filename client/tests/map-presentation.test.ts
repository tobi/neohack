import { expect, test } from "bun:test";
import {
  prepareMap,
  mapWindow,
  describeCell,
  glyph,
  MAP_LIMITS,
} from "../map-presentation.js";
const tile = (x: number, y: number, type = "floor") => ({
  x,
  y,
  terrain: { type },
});

test("presentation retains source cells without mutating or inventing knowledge", () => {
  const self = {
      ...tile(1, 1, "unknown"),
      occupant: { kind: "self", mark: "@", color: 2 },
    },
    unknown = tile(2, 1, "unknown");
  const data = { world: [self, unknown, tile(3, 1, "stairsDown")] };
  const before = JSON.stringify(data);
  const prepared = prepareMap(data);
  expect(prepared.cells).toHaveLength(2);
  expect(prepared.sources.get("1,1")).toBe(self);
  expect(prepared.cells[0].terrain.type).toBe("unknown");
  expect(JSON.stringify(data)).toBe(before);
  expect(describeCell(undefined, 2, 1)).toContain("unknown");
  expect(
    describeCell({ ...tile(1, 2), occupant: { kind: "creature", mark: "h" } }),
  ).not.toContain("hostile");
});
test("invalid, duplicate and excessive coordinates are bounded before geometry", () => {
  const data = {
    world: [
      tile(0, 0),
      tile(0, 0, "wall"),
      tile(Infinity, 0),
      tile(1.5, 2),
      tile(10001, 0),
    ],
  };
  const p = prepareMap(data);
  expect(p.cells).toHaveLength(1);
  expect(p.cells[0].terrain.type).toBe("floor");
  expect(p.warning).toContain("4");
  const many = prepareMap({
    world: Array.from({ length: MAP_LIMITS.cells + 10 }, (_, i) =>
      tile(i % 200, Math.floor(i / 200)),
    ),
  });
  expect(many.cells.length).toBe(MAP_LIMITS.cells);
  expect(many.warning).toContain("10");
});
test("sparse map windows never allocate their entire coordinate extent", () => {
  const p = prepareMap({ world: [tile(-10000, -10000), tile(10000, 10000)] });
  const view = mapWindow(p.bounds, { x: 10000, y: 10000 });
  expect(view.width * view.height).toBeLessThanOrEqual(1920);
  expect(view.x + view.width - 1).toBe(10000);
  expect(view.y + view.height - 1).toBe(10000);
  expect(Number.isFinite(mapWindow(p.bounds, { x: NaN, y: Infinity }).x)).toBe(
    true,
  );
  expect(mapWindow(null, null)).toBeNull();
});
test("complex decorations fall back, but large instanced floor/water maps remain supported", () => {
  const world = Array.from({ length: 20000 }, (_, i) =>
    tile(i % 200, Math.floor(i / 200), i % 2 ? "water" : "floor"),
  );
  expect(prepareMap({ world }).complex).toBe(false);
  expect(
    prepareMap({
      world: world.map((t, i) =>
        i < 600 ? { ...t, objects: [{ mark: "!" }] } : t,
      ),
    }).complex,
  ).toBe(true);
});
test("glyphs and descriptions are bounded and preserve perceived labels", () => {
  expect(glyph("🚀extra")).toBe("🚀");
  expect(glyph("\u0000")).toBe("?");
  expect(
    describeCell({
      ...tile(2, 3, "openDoor"),
      objects: [{ label: "blue potion" }],
    }),
  ).toContain("open door; blue potion");
  expect(
    describeCell({ ...tile(2, 3), objects: [{ label: "x".repeat(10000) }] })
      .length,
  ).toBeLessThan(160);
});
