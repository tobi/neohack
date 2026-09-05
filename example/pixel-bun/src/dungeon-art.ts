/** Original, deterministic dungeon surfaces. This module knows no game rules. */
export const RENDERER_VERSION = "stonework-2";
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
  omitDecals?: boolean;
}

const UNKNOWN = new Set(["unknown", "dark", "stone", "unexplored"]);
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
  for (const char of `${RENDERER_VERSION}:${seed}`)
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

/** All drawing is clipped to a known cell; no extrusion reveals an unknown cell. */
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
  const district = (x: number, y: number) => districtAt(seed, x, y);
  c.save();
  c.imageSmoothingEnabled = false;
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
      wall(c, x, y, wx, wy, h, p, {
        n: typeAt(wx, wy - 1) === "wall",
        s: typeAt(wx, wy + 1) === "wall",
        w: typeAt(wx - 1, wy) === "wall",
        e: typeAt(wx + 1, wy) === "wall",
      });
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
      if (
        !options.omitDoors &&
        (type === "closedDoor" || type === "openDoor" || type === "doorway")
      )
        door(
          c,
          x,
          y,
          type,
          p,
          h,
          typeAt(wx, wy - 1) === "wall" && typeAt(wx, wy + 1) === "wall",
        );
      else if (type === "stairsUp" || type === "stairsDown")
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
  const count = joins.filter(Boolean).length;
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
    if (fog && (count === 0 || (count === 1 && joins[(side + 2) % 4]))) {
      // A recessed, feathered gap is deliberately unlike a closed wall.
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

function wall(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  wx: number,
  wy: number,
  h: number,
  p: Palette,
  n: { n: boolean; e: boolean; s: boolean; w: boolean },
) {
  rect(c, "#222e2b", x, y, 16, 16);
  // Connected top plane; exposed south edge drops a full eight pixels.
  const left = n.w ? 0 : 1,
    right = n.e ? 16 : 13,
    top = n.n ? 0 : 1,
    bottom = n.s ? 16 : 8;
  rect(c, p.cap, x + left, y + top, right - left, bottom - top);
  if (!n.n) {
    rect(c, p.edge, x + left, y + top, right - left, 1);
    rect(c, p.edge, x + left, y + top + 1, 1, Math.max(1, bottom - top - 2));
  }
  if (!n.e) {
    rect(c, p.shade, x + 13, y + top + 2, 3, 16);
    rect(c, "#626959", x + 13, y + top + 1, 1, bottom - top);
  }
  // Cap joints follow world masonry courses, continuing across tile boundaries.
  const joint = mod(wy, 2) ? 5 : 11;
  if (h % 3 !== 0 || n.s) {
    rect(c, p.face, x + joint, y + top + 1, 1, bottom - top - 1);
    rect(c, p.edge, x + joint + 1, y + top + 1, 1, bottom - top - 2);
  }
  if (n.s && n.n) {
    rect(c, p.face, x + left + 1, y + 7, Math.max(1, right - left - 2), 1);
    rect(c, p.edge, x + left + 1, y + 8, Math.max(1, right - left - 2), 1);
  }
  if (!n.s) {
    rect(c, p.face, x + left, y + 8, right - left, 6);
    rect(c, p.shade, x + left, y + 14, right - left, 2);
    rect(c, "#28342f", x + left, y + 11, right - left, 1);
    const seam = mod(wx * 16 + wy * 7, 11);
    rect(
      c,
      "#303b32",
      x + left + (seam % Math.max(1, right - left)),
      y + 8,
      1,
      3,
    );
    rect(
      c,
      "#303b32",
      x + left + ((seam + 5) % Math.max(1, right - left)),
      y + 12,
      1,
      2,
    );
    rect(c, p.edge, x + left, y + 7, right - left, 1);
    if (h % 4 === 0) rect(c, "#65705b", x + 3, y + 9, 4, 1);
  }
  // Sparse repairs and cap wear share a coherent material palette.
  if (h % 5 === 0) {
    rect(c, p.edge, x + 3, y + 3, 4, 1);
    rect(c, p.face, x + 9, y + 5, 2, 1);
  }
  if (h % 7 < 2) {
    rect(c, p.moss, x + 2, y + 2, 4, 2);
    rect(c, p.moss, x + 4, y + 4, 4, 1);
    if (!n.s) rect(c, "#506344", x + 3, y + 8, 2, 4);
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
  const seed = seedHash(seedValue),
    p = palettes[hash(seed, 0, 0, 4) % palettes.length]!;
  const wallAt = (dy: number) =>
    cells.some(
      (other) =>
        other.x === cell.x &&
        other.y === cell.y + dy &&
        other.terrain.type === "wall",
    );
  door(
    c,
    x,
    y - 4,
    cell.terrain.type,
    p,
    hash(seed, cell.x, cell.y, 10),
    wallAt(-1) && wallAt(1),
  );
}

function door(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  type: string,
  p: Palette,
  h: number,
  vertical: boolean,
) {
  // A visible threshold and two stone jambs keep even side doors recognizable.
  rect(c, "#94836a", x + 2, y + 14, 12, 2);
  rect(c, p.face, x, y + 2, 3, 12);
  rect(c, p.cap, x, y, 3, 10);
  rect(c, p.face, x + 13, y + 2, 3, 12);
  rect(c, p.cap, x + 13, y, 3, 10);
  rect(c, p.edge, x, y, 3, 1);
  rect(c, p.edge, x + 13, y, 3, 1);
  if (type === "doorway") return;
  if (type === "closedDoor") {
    rect(c, "#3c342a", x + 3, y + 1, 10, 13);
    rect(c, h % 2 ? "#94754a" : "#8a704e", x + 4, y + 2, 8, 11);
    for (const i of [6, 9]) rect(c, "#5d4e37", x + i, y + 2, 1, 11);
    rect(c, "#4d5147", x + 4, y + 4, 8, 1);
    rect(c, "#4d5147", x + 4, y + 10, 8, 1);
    rect(c, "#d2b773", x + 10, y + 7, 2, 2);
  } else {
    rect(c, "#9b7b4e", x + 3, y + 2, 3, 11);
    rect(c, "#554935", x + 6, y + 4, 1, 9);
    rect(c, "#c1a268", x + 3, y + 2, 1, 10);
  }
  if (!vertical) {
    rect(c, p.cap, x + 2, y, 12, 2);
    rect(c, p.edge, x + 2, y, 12, 1);
  }
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
