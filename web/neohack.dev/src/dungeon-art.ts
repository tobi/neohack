import {
  layoutProfile,
  type LayoutType,
  type SurfacePalette as Palette,
} from "./layout-art";
import { ambienceHash, decorationAt, drawDecoration } from "./ambience";
/** Original, deterministic dungeon surfaces. This module knows no game rules. */
import {
  drawWallSprite,
  structureLayer,
  drawRockSprite,
  drawDoorSprite,
  STRUCTURE_RISE,
  STRUCTURE_OVERHANG,
} from "./structure-sprites";
export { STRUCTURE_RISE, STRUCTURE_OVERHANG } from "./structure-sprites";
export const RENDERER_VERSION = "terrain-3d-10";
export interface TerrainCell {
  x: number;
  y: number;
  visible?: boolean;
  terrain: { type: string; orientation?: "horizontal" | "vertical" };
}
export interface TerrainOptions {
  seed: string | number;
  layoutType?: LayoutType;
  originX: number;
  originY: number;
  columns: number;
  rows: number;
  /** Omit doors for isolated ground/structure studies. */
  omitDoors?: boolean;
  /** Omit raised masonry when inspecting the ground-only layer. */
  omitWalls?: boolean;
  omitDecals?: boolean;
  /** Optional presentation clock; omitted for static/reduced-motion/workshop art. */
  ambienceTimeMs?: number;
  /** Retained renderers bake the three torch frames only when a chunk needs them. */
  onAnimatedStructure?: () => void;
  /** Current public sprite anchors; world coordinates, independent of the camera. */
  readableCells?: readonly { x: number; y: number; rise: number }[];
}

const UNKNOWN = new Set(["unknown", "dark", "stone", "unexplored"]);
const DOORS = new Set(["closedDoor", "openDoor", "doorway"]);
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

/** Cosmetic surface pass. Only supplied room floor supports dressing. */
export function renderDecals(
  c: CanvasRenderingContext2D,
  cells: readonly TerrainCell[],
  options: TerrainOptions,
) {
  c.save();
  c.beginPath();
  c.rect(0, 0, options.columns * 16, options.rows * 16);
  c.clip();
  for (const cell of cells) {
    if (cell.terrain.type !== "floor") continue;
    const x = (cell.x - options.originX) * 16,
      y = (cell.y - options.originY) * 16;
    if (
      x + 16 <= 0 ||
      y + 16 <= 0 ||
      x >= options.columns * 16 ||
      y >= options.rows * 16
    )
      continue;
    const ground = decorationAt(
      options.seed,
      cell.x,
      cell.y,
      false,
      options.layoutType,
    );
    if (ground) drawDecoration(c, ground, x, y);
  }
  c.restore();
}

/** Shared perceived geometry for rasterization and precise cache invalidation. */
export function terrainGeometry(
  cells: readonly TerrainCell[],
  options: Pick<TerrainOptions, "readableCells">,
) {
  const known = new Map(
    cells.map((cell) => [`${cell.x},${cell.y}`, cell.terrain.type]),
  );
  const typeAt = (x: number, y: number) => known.get(`${x},${y}`);
  const cellsByPosition = new Map(
    cells.map((cell) => [`${cell.x},${cell.y}`, cell]),
  );
  const joinsWall = (x: number, y: number, vertical: boolean) =>
    typeAt(x, y) === "wall" ||
    (DOORS.has(typeAt(x, y) ?? "") &&
      (cellsByPosition.get(`${x},${y}`)?.terrain.orientation === "vertical") ===
        vertical);
  const surface = (x: number, y: number) => {
    const t = typeAt(x, y);
    return Boolean(t && SURFACES.has(t) && t !== "wall" && !DOORS.has(t));
  };
  const contactHeight = (x: number, y: number) => {
    if (DOORS.has(typeAt(x, y) ?? "")) return 24;
    // The south edge stays low; the east edge retains an enclosing wall.
    if (surface(x, y - 1) && !surface(x, y + 1)) return 6;
    if (surface(x - 1, y) && !surface(x + 1, y)) return 14;
    if (surface(x + 1, y) || surface(x, y + 1)) return 20;
    if (surface(x - 1, y - 1) || surface(x + 1, y - 1)) return 6;
    if (surface(x - 1, y + 1)) {
      // A disclosed northeast elbow belongs to the continuous rear cap.
      if (typeAt(x - 1, y) === "wall" && typeAt(x, y + 1) === "wall") return 20;
      return 14;
    }
    return 20;
  };
  const baseHeight = (x: number, y: number) => {
    const height = contactHeight(x, y);
    if (height !== 14 || typeAt(x, y) !== "wall") return height;
    // End the raised east run one cell before the disclosed low south elbow.
    // The preceding cell forms a shoulder. Unknown neighbors never imply an end.
    if (typeAt(x, y + 1) === "wall" && contactHeight(x, y + 1) === 6) return 6;
    if (
      typeAt(x, y + 1) === "wall" &&
      contactHeight(x, y + 1) === 14 &&
      typeAt(x, y + 2) === "wall" &&
      contactHeight(x, y + 2) === 6
    )
      return 10;
    // Carry the rear cap around the elbow and two complete cells down the east
    // run before stepping to its intermediate height. Require disclosed joins.
    for (let distance = 1; distance <= 2; distance++) {
      const cornerY = y - distance;
      if (
        Array.from({ length: distance }, (_, i) => y - i).every(
          (row) => typeAt(x, row) === "wall" && contactHeight(x, row) === 14,
        ) &&
        typeAt(x, cornerY) === "wall" &&
        typeAt(x - 1, cornerY) === "wall" &&
        surface(x - 1, cornerY + 1) &&
        contactHeight(x, cornerY) === 20
      )
        return 20;
    }
    return height;
  };
  const lowered = new Set<string>();
  for (const cell of cells) {
    if (
      cell.terrain.type !== "wall" ||
      contactHeight(cell.x, cell.y) !== 14 ||
      baseHeight(cell.x, cell.y) < 10
    )
      continue;
    const retainedHeight = baseHeight(cell.x, cell.y);
    // Bounds of the east wall's projected central band at its retained height.
    // Never use a camera-relative player radius or unseen room membership.
    const left = cell.x * 16 + 3 - retainedHeight * 0.375,
      right = cell.x * 16 + 13;
    const top = cell.y * 16 - retainedHeight * 0.75,
      bottom = cell.y * 16 + 16;
    if (
      options.readableCells?.some(
        (target) =>
          target.x * 16 + 15 > left &&
          target.x * 16 + 1 < right &&
          target.y * 16 + 15 > top &&
          target.y * 16 - target.rise < bottom,
      )
    )
      lowered.add(`${cell.x},${cell.y}`);
  }
  const heightAt = (x: number, y: number) => {
    const height = baseHeight(x, y);
    if (height < 10 || contactHeight(x, y) !== 14 || typeAt(x, y) !== "wall")
      return height;
    if (lowered.has(`${x},${y}`)) return 6;
    // A short shoulder keeps a local notch from jumping straight to full height.
    if (lowered.has(`${x},${y - 1}`) || lowered.has(`${x},${y + 1}`)) return 10;
    return height;
  };
  return { typeAt, cellsByPosition, joinsWall, heightAt };
}

/** Ground stays inside known cells; observed masonry sprites rise above their anchors. */
export function renderTerrain(
  c: CanvasRenderingContext2D,
  cells: readonly TerrainCell[],
  options: TerrainOptions,
): void {
  const { originX, originY, columns, rows } = options;
  const profile = layoutProfile(options.layoutType);
  const palettes = profile.palettes;
  const rock = profile.geometry === "rock";
  const seed = seedHash(options.seed);
  const material = hash(seed, 0, 0, 4);
  const { typeAt, cellsByPosition, joinsWall, heightAt } = terrainGeometry(
    cells,
    options,
  );
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
    const p = palettes[material % palettes.length]!;
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
      if (rock) earth(c, x, y, wx, wy, seed, p);
      else paving(c, x, y, wx, wy, seed, h, p, material, type === "corridor");
      if (type === "corridor" && !rock) {
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
        drawTombstone(c, x, y, p.face);
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
  if (!options.omitDecals) renderDecals(c, cells, options);
  // Bake connected 3D masonry after ground. Include offscreen anchors whose
  // raised/overhanging silhouette still enters the viewport.
  const layer = structureLayer(
    c,
    Math.ceil(columns * 16),
    Math.ceil(rows * 16),
  );
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
      const wallHeight = heightAt(wx, wy);
      // Dress the real south/east face, using only a supplied adjoining floor.
      // Keep fixtures away from endcaps and doorway jambs.
      const front =
        typeAt(wx, wy + 1) === "floor" &&
        [-1, 1].every((dx) => typeAt(wx + dx, wy) === "wall");
      const side =
        typeAt(wx + 1, wy) === "floor" &&
        [-1, 1].every((dy) => typeAt(wx, wy + dy) === "wall");
      const floorX = front ? wx : wx + 1,
        floorY = front ? wy + 1 : wy;
      const prop =
        wallHeight === 20 && (front || side) && !options.omitDecals
          ? decorationAt(
              options.seed,
              front ? floorX : floorY,
              front ? floorY : floorX,
              true,
              options.layoutType,
            )
          : undefined;
      const flame =
        cell.visible === true &&
        cellsByPosition.get(`${floorX},${floorY}`)?.visible === true &&
        options.ambienceTimeMs !== undefined
          ? (Math.floor(options.ambienceTimeMs / 420) +
              ambienceHash(options.seed, wx, wy, "flame")) %
            3
          : 0;
      if (
        prop === "torch" &&
        cell.visible === true &&
        cellsByPosition.get(`${floorX},${floorY}`)?.visible === true
      )
        options.onAnimatedStructure?.();
      (rock ? drawRockSprite : drawWallSprite)(
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
        wallHeight,
        palettes[material % palettes.length]!,
        hash(seed, wx, wy, 10),
        wx,
        wy,
        prop
          ? { kind: prop, side: front ? "front" : "side", flame }
          : undefined,
        layer,
      );
    }
  }
  // Doors and walls share geometric depth, including crossing jambs and caps.
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
        cell.terrain.orientation === "vertical",
        palettes[material % palettes.length]!,
        hash(seed, cell.x, cell.y, 10),
        layer,
      );
    }
  layer.paint(c);
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
      rect(c, p.floor[1]!, 5, 0, 6, 5);
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
    rect(c, p.floor[1]!, x + cx, y + cy, 4, 4);
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
  layoutType: LayoutType = "dungeon",
) {
  const palettes = layoutProfile(layoutType).palettes;
  if (!DOORS.has(cell.terrain.type)) return;
  const seed = seedHash(seedValue),
    p = palettes[hash(seed, 0, 0, 4) % palettes.length]!;
  drawDoorSprite(
    c,
    x,
    y,
    cell.terrain.type,
    cell.terrain.orientation === "vertical",
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

// Bounded document-local atlases contain only cosmetic ground,
// never visibility, occupants, wall cutaways or other observation state.
const EARTH_COLUMNS = 32;
const EARTH_CAPACITY = 2048;
class EarthAtlas {
  readonly canvas: HTMLCanvasElement;
  readonly context: CanvasRenderingContext2D;
  readonly pixels: ImageData;
  readonly colors: Uint8ClampedArray;
  readonly slots = new Map<string, number>();
  next = 0;
  constructor(
    readonly seed: number,
    readonly palette: Palette,
    document: Document,
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = EARTH_COLUMNS * 16;
    this.canvas.height = (EARTH_CAPACITY / EARTH_COLUMNS) * 16;
    this.context = this.canvas.getContext("2d")!;
    // Resolve CSS colors once, using the same canvas color conversion as before.
    [palette.light, palette.seam, ...palette.floor].forEach((color, index) => {
      rect(this.context, color, index, 0, 1, 1);
    });
    this.colors = this.context.getImageData(
      0,
      0,
      palette.floor.length + 2,
      1,
    ).data;
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.pixels = this.context.createImageData(16, 16);
  }
}
// Share the atlas across terrain chunks and replay instances in one document.
// Four recent seed/palette combinations cap bitmap storage at 8 MiB, rather
// than allocating a full atlas for every small chunk canvas.
const earthAtlases = new WeakMap<Document, Map<string, EarthAtlas>>();

/** Continuous world-space soil, baked once and copied on subsequent frames. */
function earth(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  wx: number,
  wy: number,
  seed: number,
  p: Palette,
) {
  const document = c.canvas.ownerDocument;
  let atlases = earthAtlases.get(document);
  if (!atlases) {
    atlases = new Map();
    earthAtlases.set(document, atlases);
  }
  const paletteKey = `${seed}:${p.light}:${p.seam}:${p.floor.join(",")}`;
  let atlas = atlases.get(paletteKey);
  if (!atlas) {
    atlas = new EarthAtlas(seed, p, c.canvas.ownerDocument);
    if (atlases.size >= 4) atlases.delete(atlases.keys().next().value!);
    atlases.set(paletteKey, atlas);
  }
  const key = `${wx},${wy}`;
  let slot = atlas.slots.get(key);
  if (slot === undefined) {
    slot = atlas.next;
    atlas.next = (slot + 1) % EARTH_CAPACITY;
    if (atlas.slots.size === EARTH_CAPACITY)
      atlas.slots.delete(atlas.slots.keys().next().value!);
    atlas.slots.set(key, slot);
    bakeEarth(atlas, wx, wy);
    atlas.context.putImageData(
      atlas.pixels,
      (slot % EARTH_COLUMNS) * 16,
      Math.floor(slot / EARTH_COLUMNS) * 16,
    );
  }
  c.drawImage(
    atlas.canvas,
    (slot % EARTH_COLUMNS) * 16,
    Math.floor(slot / EARTH_COLUMNS) * 16,
    16,
    16,
    x,
    y,
    16,
    16,
  );
}

function bakeEarth(atlas: EarthAtlas, wx: number, wy: number) {
  const { seed, palette: p, pixels, colors } = atlas;
  for (let py = 0; py < 16; py++)
    for (let px = 0; px < 16; px++) {
      const gx = wx * 16 + px,
        gy = wy * 16 + py;
      // Jittered mineral patches cross cell boundaries without rectangular blocks.
      let distance = Infinity,
        patch = 0;
      const bx = Math.floor(gx / 12),
        by = Math.floor(gy / 12);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const id = hash(seed, bx + dx, by + dy, 73);
          const px = (bx + dx) * 12 + (id % 12),
            py = (by + dy) * 12 + ((id >>> 8) % 12);
          const d = (gx - px) ** 2 + (gy - py) ** 2;
          if (d < distance) {
            distance = d;
            patch = id;
          }
        }
      const grain = hash(seed, gx, gy, 74);
      const color =
        (grain % 227 === 0
          ? 0
          : grain % 97 === 0
            ? 1
            : 2 + (patch % p.floor.length)) * 4;
      const pixel = (py * 16 + px) * 4;
      pixels.data[pixel] = colors[color]!;
      pixels.data[pixel + 1] = colors[color + 1]!;
      pixels.data[pixel + 2] = colors[color + 2]!;
      pixels.data[pixel + 3] = colors[color + 3]!;
    }
}

/** Existing original grave artwork, also used as a presentation-only death marker. */
export function drawTombstone(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  face = "#68715f",
) {
  rect(c, "#27322e", x + 3, y + 12, 11, 3);
  rect(c, face, x + 5, y + 3, 8, 10);
  rect(c, "#a4a38c", x + 4, y + 3, 7, 10);
  rect(c, "#a4a38c", x + 5, y + 2, 5, 2);
  rect(c, "#646e5c", x + 7, y + 5, 1, 5);
  rect(c, "#646e5c", x + 5, y + 7, 5, 1);
}
