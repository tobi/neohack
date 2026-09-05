/** Original, deterministic dungeon surfaces. This module knows no game rules. */
import {
  drawWallSprite,
  drawDoorSprite,
  STRUCTURE_RISE,
  STRUCTURE_OVERHANG,
} from "./structure-sprites";
export { STRUCTURE_RISE, STRUCTURE_OVERHANG } from "./structure-sprites";
export const RENDERER_VERSION = "masonry-3d-2";
export interface TerrainCell {
  x: number;
  y: number;
  terrain: { type: string };
}
export interface TerrainOptions {
  seed: string | number;
  originX: number;
  originY: number;
  columns: number;
  rows: number;
  /** The live client draws doors in its foreground sprite pass. */
  omitDoors?: boolean;
  /** Omit raised masonry when inspecting the ground-only layer. */
  omitWalls?: boolean;
  omitDecals?: boolean;
}

const UNKNOWN = new Set(["unknown", "dark", "stone", "unexplored"]);
const DOORS = new Set(["closedDoor", "openDoor", "doorway"]);
// Orientation is cosmetic and uses only supplied wall neighbors. A single
// known jamb is enough at the edge of exploration; ambiguous doors face south.
function sideDoor(
  typeAt: (x: number, y: number) => string | undefined,
  x: number,
  y: number,
) {
  const ns =
    Number(typeAt(x, y - 1) === "wall") + Number(typeAt(x, y + 1) === "wall");
  const ew =
    Number(typeAt(x - 1, y) === "wall") + Number(typeAt(x + 1, y) === "wall");
  return ns > ew;
}
const SURFACES = new Set([
  "wall",
  "floor",
  "corridor",
  "closedDoor",
  "openDoor",
  "doorway",
  "stairsUp",
  "stairsDown",
  "altar",
  "fountain",
  "throne",
  "trap",
  "water",
  "lava",
  "sink",
  "grass",
  "bars",
  "tree",
  "ice",
  "grave",
  "bridge",
]);
const palettes = [
  {
    floor: ["#41483e", "#454c40", "#494f43", "#3e453c"],
    seam: "#303a34",
    light: "#565e4b",
    cap: "#737765",
    edge: "#96957b",
    face: "#464d43",
    shade: "#323e39",
    moss: "#626e46",
  },
  {
    floor: ["#424b4a", "#454e4d", "#4b5250", "#3f4847"],
    seam: "#303b3d",
    light: "#596462",
    cap: "#737e79",
    edge: "#979e8c",
    face: "#475753",
    shade: "#303f40",
    moss: "#577360",
  },
  {
    floor: ["#4e4940", "#514d43", "#575146", "#49463e"],
    seam: "#3a3832",
    light: "#656050",
    cap: "#827b65",
    edge: "#aaa084",
    face: "#595443",
    shade: "#3e4238",
    moss: "#73724b",
  },
] as const;
type Palette = (typeof palettes)[number];

function seedHash(seed: string | number) {
  let h = 2166136261;
  // Keep existing surface seeds stable when only feature geometry changes.
  for (const char of `stonework-2:${seed}`)
    h = Math.imul(h ^ char.charCodeAt(0), 16777619);
  return h >>> 0;
}
function hash(seed: number, x: number, y: number, layer = 0) {
  let h =
    seed ^
    Math.imul(x, 374761393) ^
    Math.imul(y, 668265263) ^
    Math.imul(layer, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}
function mod(n: number, d: number) {
  return ((n % d) + d) % d;
}
function rect(
  c: CanvasRenderingContext2D,
  color: string,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  c.fillStyle = color;
  c.fillRect(x, y, w, h);
}

function districtAt(seed: number, x: number, y: number) {
  // Coordinate-stable material districts never depend on exploration order.
  const shiftX = hash(seed, 0, 0, 1) % 8,
    shiftY = hash(seed, 0, 0, 2) % 6;
  return hash(
    seed,
    Math.floor((x + shiftX) / 12),
    Math.floor((y + shiftY) / 9),
    3,
  );
}
function mossDecal(
  c: CanvasRenderingContext2D,
  p: Palette,
  x: number,
  y: number,
  h: number,
  region: number,
) {
  if (h % 5 > region % 3) return;
  rect(c, p.moss, x + 2, y + 2, 5, 2);
  rect(c, "#45573d", x + 4, y + 4, 4, 1);
}
/** Cosmetic surface pass. Never creates an entity, exit or hidden terrain. */
export function renderDecals(
  c: CanvasRenderingContext2D,
  cells: readonly TerrainCell[],
  options: TerrainOptions,
) {
  const seed = seedHash(options.seed),
    p = palettes[hash(seed, 0, 0, 4) % palettes.length]!;
  const walls = new Set(
    cells
      .filter((cell) => cell.terrain.type === "wall")
      .map((cell) => `${cell.x},${cell.y}`),
  );
  for (const cell of cells) {
    if (
      !["floor", "corridor"].includes(cell.terrain.type) ||
      !walls.has(`${cell.x},${cell.y - 1}`)
    )
      continue;
    if (
      cell.x < options.originX ||
      cell.y < options.originY ||
      cell.x >= options.originX + options.columns ||
      cell.y >= options.originY + options.rows
    )
      continue;
    mossDecal(
      c,
      p,
      (cell.x - options.originX) * 16,
      (cell.y - options.originY) * 16,
      hash(seed, cell.x, cell.y, 10),
      districtAt(seed, cell.x, cell.y),
    );
  }
}

/** Ground stays inside known cells; observed masonry sprites rise above their anchors. */
export function renderTerrain(
  c: CanvasRenderingContext2D,
  cells: readonly TerrainCell[],
  options: TerrainOptions,
): void {
  const { originX, originY, columns, rows } = options;
  const seed = seedHash(options.seed);
  const material = hash(seed, 0, 0, 4);
  const known = new Map(
    cells.map((cell) => [`${cell.x},${cell.y}`, cell.terrain.type]),
  );
  const typeAt = (x: number, y: number) => known.get(`${x},${y}`);
  const joinsWall = (x: number, y: number, vertical: boolean) =>
    typeAt(x, y) === "wall" ||
    (DOORS.has(typeAt(x, y) ?? "") && sideDoor(typeAt, x, y) === vertical);
  const district = (x: number, y: number) => districtAt(seed, x, y);
  const surface = (x: number, y: number) => {
    const t = typeAt(x, y);
    return Boolean(t && SURFACES.has(t) && t !== "wall" && !DOORS.has(t));
  };
  const cutaway = (x: number, y: number) =>
    (surface(x - 1, y) && !surface(x + 1, y)) ||
    (surface(x, y - 1) && !surface(x, y + 1)) ||
    // At an outer corner the room touches the wall only diagonally. Include
    // the three viewer-facing diagonals so a foreground run keeps one height
    // through its corner instead of stepping from 6 to 20 units.
    surface(x - 1, y - 1) ||
    surface(x + 1, y - 1) ||
    surface(x - 1, y + 1);
  const heightAt = (x: number, y: number) =>
    DOORS.has(typeAt(x, y) ?? "") ? 24 : cutaway(x, y) ? 6 : 20;
  c.save();
  c.imageSmoothingEnabled = false;
  c.beginPath();
  c.rect(0, 0, columns * 16, rows * 16);
  c.clip();
  for (const cell of cells) {
    const { x: wx, y: wy } = cell,
      type = cell.terrain.type;
    if (
      UNKNOWN.has(type) ||
      wx < originX ||
      wy < originY ||
      wx >= originX + columns ||
      wy >= originY + rows
    )
      continue;
    const x = (wx - originX) * 16,
      y = (wy - originY) * 16;
    const region = district(wx, wy),
      p = palettes[material % palettes.length]!;
    const h = hash(seed, wx, wy, 10);
    c.save();
    c.beginPath();
    c.rect(x, y, 16, 16);
    c.clip();
    if (!SURFACES.has(type)) {
      // Forward-compatible response strings are visible uncertainty, not floor.
      rect(c, "#bdbca0", x + 5, y + 3, 6, 2);
      rect(c, "#bdbca0", x + 9, y + 5, 2, 2);
      rect(c, "#bdbca0", x + 7, y + 7, 3, 2);
      rect(c, "#bdbca0", x + 7, y + 11, 2, 2);
    } else if (type === "wall") {
      // A footing remains inside the observed wall cell; the raised mesh is
      // composited after all floors, so tile iteration cannot erase its faces.
      rect(c, "#293630", x, y, 16, 16);
    } else if (type === "water" || type === "lava") {
      liquid(
        c,
        x,
        y,
        h,
        type === "lava",
        [
          typeAt(wx, wy - 1),
          typeAt(wx + 1, wy),
          typeAt(wx, wy + 1),
          typeAt(wx - 1, wy),
        ].map((t) => t !== undefined && !UNKNOWN.has(t) && t !== type),
      );
    } else {
      paving(c, x, y, wx, wy, seed, h, p, material, type === "corridor");
      if (type === "corridor") {
        passageEdges(
          c,
          x,
          y,
          h,
          p,
          [
            typeAt(wx, wy - 1),
            typeAt(wx + 1, wy),
            typeAt(wx, wy + 1),
            typeAt(wx - 1, wy),
          ],
          [
            typeAt(wx + 1, wy - 1),
            typeAt(wx + 1, wy + 1),
            typeAt(wx - 1, wy + 1),
            typeAt(wx - 1, wy - 1),
          ],
        );
      }
      // Ground-contact darkness belongs to the known floor, never the void.
      if (typeAt(wx, wy - 1) === "wall") {
        rect(c, "#293330", x, y, 16, 2);
        rect(c, "#354036", x + 1, y + 2, 14, 1);
        if (!options.omitDecals) mossDecal(c, p, x, y, h, region);
      }
      if (typeAt(wx - 1, wy) === "wall") rect(c, "#303b34", x, y, 2, 16);
      if (type === "stairsUp" || type === "stairsDown")
        stairs(c, x, y, type === "stairsUp", p);
      else if (type === "fountain") fountain(c, x, y, p);
      else if (type === "altar") {
        rect(c, "#293631", x + 2, y + 11, 13, 4);
        rect(c, p.face, x + 4, y + 8, 8, 6);
        rect(c, p.cap, x + 2, y + 4, 12, 5);
        rect(c, "#c0b697", x + 2, y + 3, 12, 2);
        rect(c, "#777358", x + 5, y + 5, 6, 2);
        rect(c, "#a8a081", x + 7, y + 4, 2, 4);
      } else if (type === "grass" || type === "tree") {
        for (let i = 0; i < 7; i++) {
          const n = hash(seed, wx, wy, i + 40);
          rect(
            c,
            i % 2 ? "#66704c" : "#495e43",
            x + (n % 14),
            y + ((n >>> 4) % 14),
            2,
            3,
          );
        }
        if (type === "tree") {
          rect(c, "#655340", x + 7, y + 9, 3, 6);
          rect(c, "#2e4538", x + 2, y + 3, 12, 8);
          rect(c, "#526747", x + 4, y + 1, 8, 9);
          rect(c, "#768251", x + 4, y + 2, 5, 2);
        }
      } else if (type === "ice") {
        rect(c, "#768f91", x, y, 16, 16);
        rect(c, "#93ada9", x + 1, y + 2, 10, 1);
        rect(c, "#617e87", x + 10, y + 6, 1, 6);
        rect(c, "#a4bdb5", x + 3, y + 12, 8, 1);
      } else if (type === "bars") {
        rect(c, "#2a3334", x, y + 12, 16, 3);
        for (let i = 2; i < 16; i += 4) {
          rect(c, "#a0a797", x + i, y + 1, 1, 13);
          rect(c, "#5d6b69", x + i + 1, y + 1, 1, 13);
        }
        rect(c, "#7b8780", x, y + 3, 16, 2);
      } else if (type === "bridge") {
        for (let i = 0; i < 4; i++) {
          rect(c, "#817052", x, y + i * 4, 16, 3);
          rect(c, "#ae9260", x + 1, y + i * 4, 14, 1);
        }
        rect(c, "#4e4b3c", x + 2, y, 1, 16);
        rect(c, "#4e4b3c", x + 13, y, 1, 16);
      } else if (type === "grave") {
        rect(c, "#27322e", x + 3, y + 12, 11, 3);
        rect(c, p.face, x + 5, y + 3, 8, 10);
        rect(c, "#a4a38c", x + 4, y + 3, 7, 10);
        rect(c, "#a4a38c", x + 5, y + 2, 5, 2);
        rect(c, "#646e5c", x + 7, y + 5, 1, 5);
        rect(c, "#646e5c", x + 5, y + 7, 5, 1);
      } else if (type === "sink") {
        rect(c, p.face, x + 3, y + 8, 11, 6);
        rect(c, "#abb19b", x + 2, y + 5, 12, 5);
        rect(c, "#3c5752", x + 4, y + 6, 8, 2);
        rect(c, "#bbb598", x + 10, y + 2, 2, 5);
        rect(c, "#bbb598", x + 8, y + 2, 3, 1);
      } else if (type === "throne") {
        rect(c, "#453c32", x + 4, y + 2, 9, 13);
        rect(c, "#aa915c", x + 3, y + 1, 10, 10);
        rect(c, "#735349", x + 5, y + 3, 6, 6);
        rect(c, "#c3a96b", x + 3, y + 10, 11, 2);
        rect(c, "#a48c58", x + 3, y + 12, 2, 3);
        rect(c, "#a48c58", x + 12, y + 12, 2, 3);
      } else if (type === "trap") {
        // A generic NetHack ^ marker, never an inferred pit/spike/trap species.
        rect(c, "#242d2b", x + 2, y + 4, 12, 9);
        for (let i = 0; i < 4; i++) {
          rect(c, "#d6bb84", x + 6 - i, y + 5 + i, 2, 2);
          rect(c, "#d6bb84", x + 8 + i, y + 5 + i, 2, 2);
        }
      }
    }
    c.restore();
  }
  // Bake connected 3D masonry after ground. Include offscreen anchors whose
  // raised/overhanging silhouette still enters the viewport.
  const structures = [...cells].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const cell of structures) {
    const x = (cell.x - originX) * 16,
      y = (cell.y - originY) * 16;
    if (
      x + 16 <= 0 ||
      y + 16 <= 0 ||
      x - STRUCTURE_OVERHANG >= columns * 16 ||
      y - STRUCTURE_RISE >= rows * 16
    )
      continue;
    if (cell.terrain.type === "wall" && !options.omitWalls) {
      const { x: wx, y: wy } = cell;
      drawWallSprite(
        c,
        x,
        y,
        {
          n: joinsWall(wx, wy - 1, true),
          e: joinsWall(wx + 1, wy, false),
          s: joinsWall(wx, wy + 1, true),
          w: joinsWall(wx - 1, wy, false),
          heights: [
            heightAt(wx, wy - 1),
            heightAt(wx + 1, wy),
            heightAt(wx, wy + 1),
            heightAt(wx - 1, wy),
          ],
        },
        cutaway(wx, wy),
        palettes[material % palettes.length]!,
        hash(seed, wx, wy, 10),
        wx,
        wy,
      );
    }
  }
  // Match the live fixture pass: door frames remain readable above masonry,
  // and mobile actors will be drawn in front of both by the client.
  if (!options.omitDoors)
    for (const cell of structures) {
      const x = (cell.x - originX) * 16,
        y = (cell.y - originY) * 16;
      if (
        !DOORS.has(cell.terrain.type) ||
        x + 16 <= 0 ||
        y + 16 <= 0 ||
        x - STRUCTURE_OVERHANG >= columns * 16 ||
        y - STRUCTURE_RISE >= rows * 16
      )
        continue;
      drawDoorSprite(
        c,
        x,
        y,
        cell.terrain.type,
        sideDoor(typeAt, cell.x, cell.y),
        palettes[material % palettes.length]!,
        hash(seed, cell.x, cell.y, 10),
      );
    }
  c.restore();
}

/** Cutaway stone shoulders stay INSIDE the perceived passage footprint.
 * Known adjoining surfaces join edge-to-edge. Missing neighbors are fog,
 * not collision facts: a dark central notch leaves each frontier open.
 * This never manufactures exterior cells or reads unobserved terrain. */
function passageEdges(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  h: number,
  p: Palette,
  neighbors: (string | undefined)[],
  diagonals: (string | undefined)[],
) {
  const surface = (type: string | undefined) =>
    Boolean(type && !UNKNOWN.has(type) && type !== "wall");
  const joins = neighbors.map(surface);
  for (let side = 0; side < 4; side++) {
    const neighbor = neighbors[side];
    if (joins[side]) continue;
    const fog = !neighbor || UNKNOWN.has(neighbor);
    c.save();
    c.translate(x + 8, y + 8);
    c.rotate((side * Math.PI) / 2);
    c.translate(-8, -8);
    // The upper lip catches light; its three-pixel face drops into the path.
    rect(c, "#222e2b", 0, 0, 16, 5);
    rect(c, p.cap, 0, 0, 16, 2);
    rect(c, p.face, 0, 2, 16, 2);
    rect(c, p.edge, 1, 1, 14, 1);
    rect(c, p.shade, 0, 4, 16, 1);
    const joint = 3 + (h % 8);
    rect(c, p.shade, joint, 0, 1, 3);
    if (fog) {
      // A recessed, feathered gap is deliberately unlike a closed wall.
      // Every unknown edge is uncertain, including the sides of known runs
      // and junctions; neighboring passages cannot establish a solid boundary.
      rect(c, p.floor[1], 5, 0, 6, 5);
      rect(c, p.seam, 5, 0, 6, 2);
      rect(c, "#26312f", 6, 0, 4, 1);
      rect(c, p.light, 6, 4, 4, 1);
    }
    c.restore();
  }
  // Diagonal-only perceived links should not look like disconnected islands.
  for (let corner = 0; corner < 4; corner++) {
    if (!surface(diagonals[corner]) || joins[corner] || joins[(corner + 1) % 4])
      continue;
    const cx = corner < 2 ? 12 : 0,
      cy = corner === 0 || corner === 3 ? 0 : 12;
    rect(c, p.floor[1], x + cx, y + cy, 4, 4);
    rect(c, p.light, x + cx + 1, y + cy + 1, 2, 1);
  }
}

function paving(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  wx: number,
  wy: number,
  seed: number,
  h: number,
  p: Palette,
  region: number,
  corridor: boolean,
) {
  rect(c, p.seam, x, y, 16, 16);
  const bandHeight = corridor ? 16 : region % 3 === 0 ? 12 : 16;
  const blockWidth = corridor ? 16 : region % 3 === 2 ? 24 : 32;
  const globalX = wx * 16,
    globalY = wy * 16;
  const firstBand = Math.floor(globalY / bandHeight),
    lastBand = Math.floor((globalY + 15) / bandHeight);
  for (let row = firstBand; row <= lastBand; row++) {
    const offset = mod(row, 2) * (blockWidth / 2);
    const start = Math.floor((globalX + offset) / blockWidth);
    for (
      let col = start;
      col <= Math.floor((globalX + 15 + offset) / blockWidth);
      col++
    ) {
      const px = x + col * blockWidth - offset - globalX,
        py = y + row * bandHeight - globalY;
      const block = hash(seed, col, row, 20);
      rect(
        c,
        p.floor[block % 4]!,
        px + 1,
        py + 1,
        blockWidth - 1,
        bandHeight - 1,
      );
      rect(c, p.light, px + 2, py + 1, blockWidth - 3, 1);
      if (block % 5 === 0) {
        // A worn corner and a short seam, not random confetti.
        rect(c, p.seam, px + 1, py + 1, 2, 2);
        rect(c, p.seam, px + 3, py + 3, 1, 2);
      }
      if (block % 7 === 0) {
        rect(c, p.seam, px + blockWidth - 8, py + 1, 1, 3);
        rect(c, p.seam, px + blockWidth - 9, py + 4, 1, 2);
      }
    }
  }
  if (h % 4 === 0) {
    rect(c, p.light, x + 3 + ((h >>> 6) % 8), y + 5 + ((h >>> 12) % 7), 2, 1);
  }
  if (corridor) {
    // A worn central tread separates passages from the room's large slabs.
    rect(c, p.light, x + 6, y + 7, 5, 1);
    if (h % 2 === 0) rect(c, p.moss, x + 2, y + 12, 2, 2);
  }
}

export function renderDoor(
  c: CanvasRenderingContext2D,
  cell: TerrainCell,
  cells: readonly TerrainCell[],
  seedValue: string | number,
  x: number,
  y: number,
) {
  if (!DOORS.has(cell.terrain.type)) return;
  const seed = seedHash(seedValue),
    p = palettes[hash(seed, 0, 0, 4) % palettes.length]!;
  const typeAt = (wx: number, wy: number) =>
    cells.find((other) => other.x === wx && other.y === wy)?.terrain.type;
  drawDoorSprite(
    c,
    x,
    y,
    cell.terrain.type,
    sideDoor(typeAt, cell.x, cell.y),
    p,
    hash(seed, cell.x, cell.y, 10),
  );
}

function stairs(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  up: boolean,
  p: Palette,
) {
  rect(c, "#222e2d", x + 1, y + 1, 14, 14);
  rect(c, p.cap, x + 1, y + 2, 1, 12);
  rect(c, p.shade, x + 14, y + 2, 1, 12);
  for (let i = 0; i < 4; i++) {
    const w = up ? 6 + i * 2 : 12 - i * 2;
    rect(
      c,
      i === 3 && !up ? p.face : p.cap,
      x + 8 - w / 2,
      y + 2 + i * 3,
      w,
      2,
    );
    rect(
      c,
      i === 3 && !up ? p.cap : p.edge,
      x + 8 - w / 2,
      y + 2 + i * 3,
      w,
      1,
    );
  }
}
function fountain(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  p: Palette,
) {
  rect(c, "#253731", x + 3, y + 13, 11, 2);
  rect(c, p.face, x + 2, y + 8, 12, 5);
  rect(c, p.cap, x + 1, y + 7, 14, 4);
  rect(c, "#a7af97", x + 3, y + 6, 10, 1);
  rect(c, "#396c6d", x + 3, y + 7, 10, 2);
  rect(c, "#82aaa0", x + 4, y + 8, 7, 1);
  rect(c, "#899781", x + 7, y + 3, 3, 6);
  rect(c, "#c1c9a9", x + 7, y + 2, 3, 2);
  rect(c, "#759e98", x + 5, y + 3, 2, 3);
  rect(c, "#a9cbc0", x + 5, y + 3, 1, 2);
}
function liquid(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  h: number,
  lava: boolean,
  banks: boolean[],
) {
  const base = lava ? "#793f30" : "#294c51",
    ripple = lava ? "#c77f46" : "#517a79",
    shine = lava ? "#ecac5a" : "#71938a";
  rect(c, base, x, y, 16, 16);
  rect(c, lava ? "#934b32" : "#30595c", x, y + 8, 16, 5);
  const a = h % 7,
    b = (h >>> 5) % 8;
  rect(c, ripple, x + a, y + 4, 6, 1);
  rect(c, shine, x + a + 2, y + 3, 3, 1);
  rect(c, ripple, x + b, y + 12, 7, 1);
  const bank = lava ? "#5b4235" : "#627467";
  if (banks[0]) {
    rect(c, "#233b39", x, y, 16, 2);
    rect(c, bank, x + 1, y, 14, 1);
  }
  if (banks[1]) rect(c, bank, x + 15, y + 1, 1, 14);
  if (banks[2]) {
    rect(c, ripple, x, y + 14, 16, 1);
    rect(c, bank, x, y + 15, 16, 1);
  }
  if (banks[3]) rect(c, bank, x, y + 1, 1, 14);
}
