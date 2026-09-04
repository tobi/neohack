// sprites.js — glyph (ttychar + NetHack color) -> atlas tile mapping.
// No game rules, no rendering: pure data mapping used by index.html to
// build renderer cells. Tile names refer to client/assets/atlas.json.
//
// Returns { tile, tint, wall, bill, under }:
//   tile  atlas tile name for the billboard / ground decal
//   tint  true  -> multiply sprite by the NH color (white-base entities)
//         false -> sprite is pre-colored, use white
//   wall  true  -> structural wall (renderer auto-tiles + extrudes)
//   bill  true  -> upright billboard over `under` ground (entities, items,
//                  furniture); false -> flat ground decal
//   under ground tile beneath a billboard (or the flat tile itself)
const MON = {
  a: "e_ant", b: "e_bat", c: "e_quadruped", d: "e_quadruped", e: "e_eye",
  f: "e_feline", g: "e_humanoid", h: "e_humanoid", i: "e_small_humanoid",
  j: "e_blob", k: "e_small_humanoid", l: "e_small_humanoid", m: "e_mimic",
  n: "e_serpent", o: "e_humanoid", p: "e_blob", q: "e_quadruped",
  r: "e_rodent", s: "e_spider", t: "e_blob", u: "e_unicorn", v: "e_vortex",
  w: "e_worm", x: "e_ant", y: "e_big_humanoid", z: "e_humanoid",
  A: "e_angel", B: "e_bird", C: "e_quadruped", D: "e_dragon", E: "e_golem",
  F: "e_mushroom", G: "e_big_humanoid", H: "e_big_humanoid",
  I: "e_ghost", J: "e_bird", K: "e_small_humanoid", L: "e_wraith",
  M: "e_humanoid", N: "e_humanoid", O: "e_big_humanoid", P: "e_worm",
  Q: "e_demon", R: "e_quadruped", S: "e_serpent", T: "e_big_humanoid",
  U: "e_big_humanoid", V: "e_humanoid", W: "e_wraith", X: "e_bird",
  Y: "e_big_humanoid", Z: "e_dragon",
  "&": "e_demon", ";": "e_tentacle", ":": "e_lizard", "'": "e_golem",
};

const ITEM = {
  $: "gold", "!": "potion", "?": "scroll", "/": "wand", "=": "ring",
  "(": "sword", ")": "dagger", "[": "shield", "%": "food", "*": "gem",
  "0": "boulder", "`": "statue",
};

// NetHack color indices that read as "lit" for floor/corridor shading.
const BRIGHT = new Set([7, 9, 10, 11, 13, 14, 15]);

export function spriteFor(ch, colorIdx = 7) {
  if (!ch) return { tile: "unknown", tint: false, wall: false, bill: false, under: "floor_dark" };
  // Player / humans.
  if (ch === "@") return { tile: "e_player", tint: false, wall: false, bill: true, under: "floor" };
  // Structural walls (auto-tiled + extruded by the renderer).
  if (ch === "-" || ch === "|") return { tile: "wall_cross", tint: false, wall: true, bill: false, under: "floor" };
  // Terrain features.
  switch (ch) {
    case ".": return { tile: BRIGHT.has(colorIdx) ? "floor" : "floor_dark", tint: false, wall: false, bill: false, under: null };
    case "#": // corridor — or a tree / bars in disguise
      if (colorIdx === 2 || colorIdx === 10) return { tile: "tree", tint: false, wall: false, bill: true, under: "grass" };
      return { tile: "corridor", tint: false, wall: false, bill: false, under: null };
    case "+": return { tile: "door_c", tint: false, wall: false, bill: false, under: null };
    case "<": return { tile: "stair_up", tint: false, wall: false, bill: false, under: null };
    case ">": return { tile: "stair_dn", tint: false, wall: false, bill: false, under: null };
    case "_": return { tile: "altar", tint: false, wall: false, bill: true, under: "floor" };
    case "{": return { tile: "fountain", tint: false, wall: false, bill: true, under: "floor" };
    case "}":
      if (colorIdx === 1 || colorIdx === 9) return { tile: "lava", tint: false, wall: false, bill: false, under: null };
      if (colorIdx === 4 || colorIdx === 12 || colorIdx === 14) return { tile: "water", tint: false, wall: false, bill: false, under: null };
      return { tile: "sink", tint: false, wall: false, bill: true, under: "floor" };
    case "\\": return { tile: "throne", tint: false, wall: false, bill: true, under: "floor" };
    case "^": return { tile: "trap", tint: false, wall: false, bill: false, under: null };
    case '"':
      if (colorIdx === 2 || colorIdx === 3 || colorIdx === 10) return { tile: "grass", tint: false, wall: false, bill: false, under: null };
      return { tile: "amulet", tint: false, wall: false, bill: true, under: "floor" };
  }
  // Items.
  if (ITEM[ch]) {
    return { tile: ITEM[ch], tint: false, wall: false, bill: true, under: "floor" };
  }
  // Monsters (tinted by NetHack color).
  if (MON[ch]) return { tile: MON[ch], tint: true, wall: false, bill: true, under: "floor" };
  // Pets render as dogs when close to the player's tracked color? The
  // engine doesn't tag pets; dogs/kitten glyphs are plain 'd'/'f'.
  return { tile: "unknown", tint: false, wall: false, bill: false, under: "floor_dark" };
}

// 'd' next to the player at game start is usually the pet: callers may
// swap e_dog in for the first adjacent quadruped. Helper exposed for that.
export function petTile() {
  return "e_dog";
}
