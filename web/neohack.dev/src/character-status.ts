import type { Observation } from "neonethack/types";
/** Presentation of canonical facts shared by the HUD and character sheet. */
export function characterStatus(o: Observation) {
  const v = o.vitals;
  const conditions = [
    ...new Set(
      [
        v.hunger !== "not_hungry" ? v.hungerLabel : "",
        v.burden !== "unencumbered" ? v.burdenLabel : "",
        ...(Array.isArray(v.condition) ? v.condition : [v.condition]),
      ].filter(
        (value) => value && value !== "not_hungry" && value !== "unencumbered",
      ),
    ),
  ].join(" · ");
  return {
    conditions,
    depth: "lvl: " + o.location.depthLabel.replace(/^Dlvl:/, ""),
    stats: [
      ["Health", `${v.health ?? "?"} / ${v.maxHealth ?? "?"}`],
      ["Energy", `${v.energy ?? "?"} / ${v.maxEnergy ?? "?"}`],
      ["Armor class", v.armor ?? "?"],
      ["Hero level", v.level ?? "?"],
      ["Strength", v.strength ?? "?"],
      ["Gold", v.gold ?? "?"],
    ] as const,
  };
}
