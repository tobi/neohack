import defaults from "../art/layout-types/defaults/profile.json";
import dungeon from "../art/layout-types/dungeon/profile.json";
import cave from "../art/layout-types/cave/profile.json";
import damp from "../art/layout-types/dungeon-damp/profile.json";
export type LayoutType = "dungeon" | "dungeon-damp" | "cave";
export interface SurfacePalette {
  floor: readonly string[];
  seam: string; light: string; cap: string; edge: string;
  face: string; shade: string; moss: string;
}
interface Profile {
  geometry: string;
  palettes: readonly SurfacePalette[];
  decorations: readonly string[];
}
/** Explicit style configuration, never inferred from hidden terrain or depth. */
const profiles: Record<LayoutType, Profile> = {
  dungeon: { ...defaults, ...dungeon },
  cave: { ...defaults, ...cave },
  "dungeon-damp": { ...defaults, ...damp },
};
export function layoutProfile(type: LayoutType = "dungeon"): Profile {
  if (!Object.hasOwn(profiles, type)) throw Error(`Unknown layout art type: ${type}`);
  return profiles[type];
}

/** Cosmetic environment only. Input is the client's game-seed/public-level key,
 * never terrain inference or an assertion about the engine's dungeon branch. */
export function layoutForSeed(seed: string | number): LayoutType {
  let h = 2166136261;
  for (const char of `environment-1:${seed}`)
    h = Math.imul(h ^ char.charCodeAt(0), 16777619);
  return (["dungeon", "dungeon-damp", "cave"] as const)[(h >>> 0) % 3]!;
}
