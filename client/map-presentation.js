// Presentation bounds only. Never infer terrain, hostility or item properties.
export const MAP_LIMITS = Object.freeze({
  cells: 20000,
  coordinate: 10000,
  detailed: 512,
  columns: 80,
  rows: 24,
});
const simple = new Set([
  "unknown",
  "dark",
  "floor",
  "corridor",
  "wall",
  "ice",
  "water",
  "lava",
]);
export function glyph(mark, fallback = "?") {
  if (
    typeof mark !== "string" ||
    !mark ||
    mark === "\\u0000" ||
    mark.codePointAt(0) < 32
  )
    return fallback;
  return String.fromCodePoint(mark.codePointAt(0));
}
export function prepareMap(observation) {
  const world = Array.isArray(observation?.world) ? observation.world : [];
  const cells = [],
    sources = new Map();
  let omitted = Math.max(0, world.length - MAP_LIMITS.cells),
    detail = 0;
  for (let i = 0; i < Math.min(world.length, MAP_LIMITS.cells); i++) {
    const t = world[i];
    if (
      !t ||
      !Number.isSafeInteger(t.x) ||
      !Number.isSafeInteger(t.y) ||
      Math.abs(t.x) > MAP_LIMITS.coordinate ||
      Math.abs(t.y) > MAP_LIMITS.coordinate
    ) {
      omitted++;
      continue;
    }
    const key = `${t.x},${t.y}`;
    if (sources.has(key)) {
      omitted++;
      continue;
    }
    const type =
      typeof t.terrain?.type === "string" && t.terrain.type.length <= 40
        ? t.terrain.type
        : "unknown";
    const raw = t.occupant;
    const occupant =
      raw &&
      typeof raw === "object" &&
      (raw.mark || ["self", "ally", "creature"].includes(raw.kind))
        ? {
            kind: ["self", "ally", "creature"].includes(raw.kind)
              ? raw.kind
              : "unknown",
            mark: glyph(raw.mark, raw.kind === "self" ? "@" : "?"),
            color: Number.isFinite(raw.color) ? raw.color & 15 : 7,
          }
        : null;
    const object =
      Array.isArray(t.objects) &&
      t.objects[0] &&
      typeof t.objects[0] === "object"
        ? t.objects[0]
        : null;
    const objects = object
      ? [
          {
            mark: glyph(object.mark),
            color: Number.isFinite(object.color) ? object.color & 15 : 7,
          },
        ]
      : [];
    if (["unknown", "dark"].includes(type) && !occupant && !object) continue;
    cells.push({ x: t.x, y: t.y, terrain: { type }, occupant, objects });
    sources.set(key, t);
    detail += Number(!simple.has(type)) + Number(!!occupant) + Number(!!object);
  }
  let bounds = null;
  for (const c of cells) {
    if (!bounds) bounds = { minX: c.x, maxX: c.x, minY: c.y, maxY: c.y };
    else {
      bounds.minX = Math.min(bounds.minX, c.x);
      bounds.maxX = Math.max(bounds.maxX, c.x);
      bounds.minY = Math.min(bounds.minY, c.y);
      bounds.maxY = Math.max(bounds.maxY, c.y);
    }
  }
  return {
    cells,
    sources,
    bounds,
    complex: detail > MAP_LIMITS.detailed,
    warning: omitted
      ? `${omitted} invalid, duplicate or excess map entries were omitted.`
      : "",
  };
}
export function mapWindow(bounds, point) {
  if (!bounds) return null;
  const width = Math.min(MAP_LIMITS.columns, bounds.maxX - bounds.minX + 1),
    height = Math.min(MAP_LIMITS.rows, bounds.maxY - bounds.minY + 1);
  const px = Number.isSafeInteger(point?.x) ? point.x : bounds.minX,
    py = Number.isSafeInteger(point?.y) ? point.y : bounds.minY;
  const x = Math.max(
    bounds.minX,
    Math.min(bounds.maxX - width + 1, px - Math.floor(width / 2)),
  );
  const y = Math.max(
    bounds.minY,
    Math.min(bounds.maxY - height + 1, py - Math.floor(height / 2)),
  );
  return { x, y, width, height };
}
export function describeCell(cell, x = cell?.x, y = cell?.y) {
  if (!cell) return `${x}, ${y}: unknown; no perceived tile`;
  const terrain =
    typeof cell.terrain?.type === "string"
      ? cell.terrain.type
          .slice(0, 40)
          .replace(/([a-z])([A-Z])/g, "$1 $2")
          .toLowerCase()
      : "unknown terrain";
  const o = cell.occupant;
  const occupant =
    o?.kind === "self"
      ? "you"
      : o
        ? `${o.kind === "ally" ? "ally" : o.kind === "creature" ? "creature" : "occupant"} ${glyph(o.mark)}`
        : "";
  const objects = Array.isArray(cell.objects) ? cell.objects : [];
  const names = objects
    .slice(0, 3)
    .map((o) =>
      typeof o?.label === "string"
        ? o.label.slice(0, 120)
        : `object ${glyph(o?.mark)}`,
    );
  if (objects.length > 3)
    names.push(`${objects.length - 3} more recorded objects`);
  return [`${x}, ${y}: ${terrain}`, occupant, ...names]
    .filter(Boolean)
    .join("; ");
}
