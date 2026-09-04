// Read-only projection of one observation. No name parsing or game rules.
export const displayValue = (v) =>
  v === undefined || v === null
    ? "Not reported"
    : String(v).trim() || "None reported";
export const words = (v) =>
  String(v ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .trim();
export function freshness(value) {
  return value === "current"
    ? "Current at this boundary"
    : value === "lastKnown"
      ? "Last reported — may have changed"
      : value === "unknown"
        ? "Not observed"
        : "Freshness not recorded";
}
const own = (p) => p && Number.isSafeInteger(p.x) && Number.isSafeInteger(p.y);
export function inspectionData(observation, target) {
  const o = observation ?? {},
    v = o.vitals ?? {},
    world = Array.isArray(o.world) ? o.world : [];
  if (target === "self") {
    const inventory = Array.isArray(o.inventory) ? o.inventory : [];
    const equipmentKnown =
      o.inventoryKnown === true &&
      ["current", "lastKnown"].includes(o.perception?.equipment) &&
      inventory.every((i) => Array.isArray(i.usage));
    return {
      kind: "self",
      title:
        typeof v.title === "string"
          ? v.title.trim() || "The explorer"
          : "The explorer",
      context: own(o.you) ? `${o.you.x}, ${o.you.y}` : "Position not reported",
      rows: [
        [
          "Health",
          v.health == null
            ? "Not reported"
            : `${v.health} / ${displayValue(v.maxHealth)}`,
        ],
        [
          "Energy",
          v.energy == null
            ? "Not reported"
            : `${v.energy} / ${displayValue(v.maxEnergy)}`,
        ],
        ["Armor class", displayValue(v.armor)],
        ["Experience level", displayValue(v.level)],
        ["Experience points", displayValue(v.experience)],
        ["Gold", displayValue(v.gold)],
        ["Strength", displayValue(v.strength)],
        ["Dexterity", displayValue(v.dexterity)],
        ["Constitution", displayValue(v.constitution)],
        ["Intelligence", displayValue(v.intelligence)],
        ["Wisdom", displayValue(v.wisdom)],
        ["Charisma", displayValue(v.charisma)],
        ["Alignment", displayValue(v.alignment)],
        ["Hunger notice", displayValue(v.hunger)],
        ["Burden notice", displayValue(v.burden)],
      ],
      conditions: Array.isArray(v.condition) ? v.condition : null,
      inventoryKnown: o.inventoryKnown === true,
      inventory,
      equipmentKnown,
      equipment: equipmentKnown ? inventory.filter((i) => i.usage.length) : [],
      inventoryFreshness: freshness(o.perception?.inventory),
      equipmentFreshness: freshness(o.perception?.equipment),
      inventoryState: o.perception?.inventory,
      equipmentState: o.perception?.equipment,
    };
  }
  const point = target === "here" ? o.you : target;
  if (!own(point))
    return {
      kind: "unknown",
      title: "Position unavailable",
      rows: [],
      notice: "The observation does not contain a usable position.",
    };
  const cell = world.find((c) => c.x === point.x && c.y === point.y),
    here = own(o.you) && point.x === o.you.x && point.y === o.you.y;
  const occupant = cell?.occupant;
  const occupantText = occupant
    ? occupant.kind === "self"
      ? "You"
      : `${words(occupant.kind) || "Occupant"}${occupant.mark ? ` · ${occupant.mark}` : ""}`
    : cell
      ? "None reported"
      : "Not observed";
  return {
    kind: target === "here" ? "here" : "tile",
    title: target === "here" ? "Here" : `Square ${point.x}, ${point.y}`,
    context: `${point.x}, ${point.y}`,
    rows: [
      [
        "Terrain",
        cell ? words(cell.terrain?.type) || "Unknown" : "Not observed",
      ],
      [
        "Terrain knowledge",
        cell
          ? words(cell.terrain?.knowledge) || "Not reported"
          : "Not observed",
      ],
      ["Occupant", occupantText],
    ],
    here,
    known: here && o.here?.known === true,
    items:
      here && o.here?.known === true && Array.isArray(o.here.items)
        ? o.here.items
        : [],
    sightings: !here && Array.isArray(cell?.objects) ? cell.objects : [],
    freshness: freshness(here ? o.perception?.here : undefined),
    freshnessState: here ? o.perception?.here : undefined,
    notice: !cell
      ? "This square is not present in the current observation. No previous-frame contents are carried forward."
      : here && o.here?.known !== true
        ? "Floor contents were not observed. This does not mean the square is empty."
        : !here
          ? "Only map sightings are available away from the explorer. No unseen stack contents are inferred."
          : null,
  };
}
