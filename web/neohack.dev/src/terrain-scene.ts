import {
  renderTerrain,
  terrainGeometry,
  type TerrainCell,
  type TerrainOptions,
} from "./dungeon-art";
import type { SceneSprite } from "./retained-scene";

const CHUNK = 8;
const UNKNOWN = new Set(["unknown", "dark", "stone", "unexplored"]);
/** Static chunks stay in world coordinates. Camera and animation clocks are
 * deliberately absent from their keys. Neighbor margins preserve masonry joins. */
export class TerrainScene {
  private chunks = new Map<
    string,
    { signature: string; sprite: SceneSprite }
  >();
  private signature = "";
  private sprites: SceneSprite[] = [];
  constructor(private document: Document) {}
  prepare(
    cells: readonly TerrainCell[],
    options: Pick<TerrainOptions, "seed" | "layoutType" | "readableCells">,
    motion: boolean,
  ) {
    const geometry = terrainGeometry(cells, options);
    const heights = cells
      .filter((cell) => cell.terrain.type === "wall")
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map((cell) => [cell.x, cell.y, geometry.heightAt(cell.x, cell.y)]);
    const signature = JSON.stringify([
      options.seed,
      options.layoutType,
      motion,
      [...cells]
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .map((cell) => [
          cell.x,
          cell.y,
          cell.terrain.type,
          cell.terrain.orientation,
          cell.visible,
        ]),
      heights,
    ]);
    if (signature === this.signature) return this.sprites;
    const keys = new Set<string>();
    for (const cell of cells)
      if (!UNKNOWN.has(cell.terrain.type)) {
        // Raised silhouettes may enter the chunk above or to the left.
        for (const dx of [0, -1])
          for (const dy of [0, -2])
            keys.add(
              `${Math.floor((cell.x + dx) / CHUNK)},${Math.floor((cell.y + dy) / CHUNK)}`,
            );
      }
    const result: SceneSprite[] = [];
    for (const key of keys) {
      const [cx, cy] = key.split(",").map(Number) as [number, number];
      const x = cx * CHUNK,
        y = cy * CHUNK;
      // Wall shoulders inspect up to three neighbors; use the complete public
      // scene to render, and a conservative local dependency set to invalidate.
      const near = cells
        .filter(
          (cell) =>
            cell.x >= x - 4 &&
            cell.x < x + CHUNK + 4 &&
            cell.y >= y - 4 &&
            cell.y < y + CHUNK + 4,
        )
        .sort((a, b) => a.y - b.y || a.x - b.x);
      const signature = JSON.stringify([
        options.seed,
        options.layoutType,
        motion,
        near.map((cell) => [
          cell.x,
          cell.y,
          cell.terrain.type,
          cell.terrain.orientation,
          cell.visible,
        ]),
        heights.filter(
          ([wx, wy]) =>
            wx! >= x - 4 &&
            wx! < x + CHUNK + 4 &&
            wy! >= y - 4 &&
            wy! < y + CHUNK + 4,
        ),
      ]);
      let cached = this.chunks.get(key);
      if (!cached || cached.signature !== signature) {
        const canvas = this.document.createElement("canvas");
        canvas.width = canvas.height = CHUNK * 16;
        const context = canvas.getContext("2d")!;
        let animated = false;
        const terrain: TerrainOptions = {
          ...options,
          originX: x,
          originY: y,
          columns: CHUNK,
          rows: CHUNK,
          ambienceTimeMs: motion ? 0 : undefined,
          onAnimatedStructure: () => {
            animated = true;
          },
        };
        renderTerrain(context, cells, terrain);
        const frames = motion && animated ? 3 : 1;
        const sprite: SceneSprite = {
          key: `terrain:${key}`,
          signature,
          x: x * 16,
          y: y * 16,
          width: CHUNK * 16,
          height: CHUNK * 16,
          z: 0,
          frames,
          period: 420,
          paint: (c, frame) => {
            if (frame === 0) c.drawImage(canvas, 0, 0);
            else
              renderTerrain(c, cells, {
                ...terrain,
                ambienceTimeMs: frame * 420,
                onAnimatedStructure: undefined,
              });
          },
        };
        cached = { signature, sprite };
        this.chunks.set(key, cached);
      }
      result.push(cached.sprite);
    }
    for (const key of this.chunks.keys())
      if (!keys.has(key)) this.chunks.delete(key);
    this.signature = signature;
    this.sprites = result;
    return result;
  }
  clear() {
    this.chunks.clear();
    this.signature = "";
    this.sprites = [];
  }
}
