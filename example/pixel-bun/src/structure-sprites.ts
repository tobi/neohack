import { wallDecorationPixel, type Decoration } from "./ambience";
/** Small 3D masonry meshes baked to native-resolution sprites. No game rules. */
export const STRUCTURE_RISE = 18;
export const STRUCTURE_OVERHANG = 9;
export interface StonePalette {
  cap: string;
  edge: string;
  face: string;
  shade: string;
  moss: string;
}
export interface WallShape {
  n: boolean;
  e: boolean;
  s: boolean;
  w: boolean;
  /** Neighbor heights expose the riser where full walls meet a cutaway. */
  heights: readonly [number, number, number, number];
}
interface WallDecoration { kind: Decoration; side: "front" | "side"; flame: number }
type Point = readonly [number, number, number];
type Material = "stone" | "wood" | "brass" | "rock";
interface Face {
  vertices: readonly Point[];
  side: "top" | "front" | "side";
  material: Material;
  rim?: boolean;
  tone?: number;
}
const WIDTH = 16 + STRUCTURE_OVERHANG;
const HEIGHT = 16 + STRUCTURE_RISE;
const cache = new Map<string, HTMLCanvasElement>();
const mod = (n: number, d: number) => ((n % d) + d) % d;
const hash = (x: number, y: number, z: number) =>
  (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>>
  0;

// Fixed oblique view: the ground remains the client's square 16px grid, while
// height projects toward the northwest. This is a sprite bake, not a second
// gameplay camera, collision model, or WebGL context.
function project([x, y, z]: Point): Point {
  return [x - z * 0.375 + STRUCTURE_OVERHANG, y - z * 0.75 + STRUCTURE_RISE, z];
}
function box(
  faces: Face[],
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  material: Material,
  sideDoor = false,
) {
  if (sideDoor) [x0, y0, x1, y1] = [y0, x0, y1, x1];
  faces.push(
    {
      vertices: [
        [x0, y0, z1],
        [x1, y0, z1],
        [x1, y1, z1],
        [x0, y1, z1],
      ],
      side: "top",
      material,
    },
    {
      vertices: [
        [x0, y1, z0],
        [x1, y1, z0],
        [x1, y1, z1],
        [x0, y1, z1],
      ],
      side: "front",
      material,
    },
    {
      vertices: [
        [x1, y0, z0],
        [x1, y1, z0],
        [x1, y1, z1],
        [x1, y0, z1],
      ],
      side: "side",
      material,
    },
  );
}
function bake(
  faces: readonly Face[],
  palette: StonePalette,
  variant: number,
  phaseX: number,
  phaseY: number,
  decoration?: WallDecoration,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext("2d")!;
  const pixels = context.createImageData(WIDTH, HEIGHT);
  const depth = new Float32Array(WIDTH * HEIGHT).fill(-Infinity);
  const colors = new Map<string, readonly number[]>();
  const color = (hex: string) => {
    let rgb = colors.get(hex);
    if (!rgb) {
      rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      colors.set(hex, rgb);
    }
    return rgb;
  };
  const texture = (face: Face, x: number, y: number, z: number) => {
    if (face.material === "rock") {
      const grain = hash(Math.floor(x + phaseX), Math.floor(y + phaseY), Math.floor(z) + variant);
      if (grain % 109 === 0) return palette.moss;
      if (face.side === "top") return face.tone === 0 ? palette.edge : face.tone === 1 ? palette.cap : palette.face;
      const fracture = hash(Math.floor((x+phaseX+z*.25)/5),Math.floor((y+phaseY)/5),variant);
      if (Math.floor(z) === 3 + fracture % 11 && grain % 3 !== 0) return palette.shade;
      return face.side === "side" || face.tone === 2 ? palette.shade : face.tone === 0 ? palette.cap : palette.face;
    }
    if (face.material === "brass")
      return face.side === "side" ? "#8e6f39" : "#d6b571";
    if (face.material === "wood") {
      if (face.side === "top") return "#b19059";
      const height = Math.floor(z);
      if ((height >= 4 && height < 6) || (height >= 14 && height < 16))
        return mod(Math.floor(x + y), 8) === 3 ? "#a0a48c" : "#34433c";
      const plank = mod(Math.floor(x + y), 3);
      if (plank === 0) return "#55432e";
      return face.side === "side"
        ? plank === 1
          ? "#8e6e41"
          : "#705332"
        : plank === 1
          ? "#b09058"
          : "#927143";
    }
    if (face.side === "top") {
      if (face.rim) return palette.edge;
      const row = Math.floor((y + phaseY) / 6);
      if (
        mod(Math.floor(x + phaseX) + row * 4, 10) === 0 ||
        mod(Math.floor(y + phaseY), 6) === 0
      )
        return palette.face;
      return hash(Math.floor((x + phaseX) / 4), row, variant) % 19 === 0
        ? palette.moss
        : palette.cap;
    }
    if (decoration && face.side === decoration.side &&
        (face.side === "front" ? y >= 13 : x >= 13)) {
      const ink = wallDecorationPixel(decoration.kind, face.side === "front" ? x : y, z, decoration.flame);
      if (ink) return ink;
    }
    const course = Math.floor(z / 5);
    const along = face.side === "front" ? x + phaseX : y + phaseY;
    if (
      mod(Math.floor(z), 5) === 0 ||
      mod(Math.floor(along) + course * 5, 11) === 0
    )
      return palette.shade;
    if (mod(Math.floor(z), 5) === 4 && face.side === "front")
      return palette.cap;
    return face.side === "front" ? palette.face : "#3b4942";
  };
  // Pixel-center triangle rasterization with a depth buffer and deterministic
  // face order: no antialiasing or gaps between canvas paths.
  for (const face of faces)
    for (let k = 1; k < face.vertices.length - 1; k++) {
      const world = [
        face.vertices[0]!,
        face.vertices[k]!,
        face.vertices[k + 1]!,
      ] as const;
      const [a, b, c] = world.map(project) as [Point, Point, Point];
      const area =
        (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
      if (!area) continue;
      const left = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
      const right = Math.min(WIDTH, Math.ceil(Math.max(a[0], b[0], c[0])));
      const top = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
      const bottom = Math.min(HEIGHT, Math.ceil(Math.max(a[1], b[1], c[1])));
      for (let py = top; py < bottom; py++)
        for (let px = left; px < right; px++) {
          const sx = px + 0.5,
            sy = py + 0.5;
          const wa =
            ((b[1] - c[1]) * (sx - c[0]) + (c[0] - b[0]) * (sy - c[1])) / area;
          const wb =
            ((c[1] - a[1]) * (sx - c[0]) + (a[0] - c[0]) * (sy - c[1])) / area;
          const wc = 1 - wa - wb;
          if (wa < -1e-7 || wb < -1e-7 || wc < -1e-7) continue;
          const z = wa * a[2] + wb * b[2] + wc * c[2];
          const offset = py * WIDTH + px;
          if (z < depth[offset]! - 1e-5) continue;
          depth[offset] = z;
          const x = wa * world[0][0] + wb * world[1][0] + wc * world[2][0];
          const y = wa * world[0][1] + wb * world[1][1] + wc * world[2][1];
          const rgb = color(texture(face, x, y, z));
          pixels.data.set([rgb[0]!, rgb[1]!, rgb[2]!, 255], offset * 4);
        }
    }
  context.putImageData(pixels, 0, 0);
  return canvas;
}
function sprite(key: string, build: () => HTMLCanvasElement) {
  let result = cache.get(key);
  if (!result) {
    result = build();
    // Bounded across long adventures and many display seeds.
    if (cache.size >= 256) cache.delete(cache.keys().next().value!);
    cache.set(key, result);
  }
  return result;
}
export function drawWallSprite(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  shape: WallShape,
  height: number,
  palette: StonePalette,
  variation: number,
  wx: number,
  wy: number,
  decoration?: WallDecoration,
) {
  const mask =
    Number(shape.n) |
    (Number(shape.e) << 1) |
    (Number(shape.s) << 2) |
    (Number(shape.w) << 3);
  const phaseX = mod(wx * 16, 30),
    phaseY = mod(wy * 16, 30),
    variant = variation % 4;
  const key = `wall:${mask}:${height}:${shape.heights.join(",")}:${palette.cap}:${variant}:${phaseX}:${phaseY}:${decoration?.kind ?? ""}:${decoration?.side ?? ""}:${decoration?.flame ?? 0}`;
  const image = sprite(key, () => {
    const faces: Face[] = [];
    const occupied = (xx: number, yy: number): boolean => {
      if (yy < 0 && shape.heights[0] < height) return false;
      if (xx >= 16 && shape.heights[1] < height) return false;
      if (yy >= 16 && shape.heights[2] < height) return false;
      if (xx < 0 && shape.heights[3] < height) return false;
      const middleX = xx >= 3 && xx < 13,
        middleY = yy >= 3 && yy < 13;
      return (
        (middleX && middleY) ||
        (shape.n && middleX && yy < 3) ||
        (shape.s && middleX && yy >= 13) ||
        (shape.w && middleY && xx < 3) ||
        (shape.e && middleY && xx >= 13)
      );
    };
    for (let yy = 0; yy < 16; yy++)
      for (let xx = 0; xx < 16; xx++) {
        if (!occupied(xx, yy)) continue;
        faces.push({
          vertices: [
            [xx, yy, height],
            [xx + 1, yy, height],
            [xx + 1, yy + 1, height],
            [xx, yy + 1, height],
          ],
          side: "top",
          material: "stone",
          rim: !occupied(xx - 1, yy) || !occupied(xx, yy - 1),
        });
        if (!occupied(xx + 1, yy))
          faces.push({
            vertices: [
              [xx + 1, yy, xx === 15 && shape.e ? shape.heights[1] : 0],
              [xx + 1, yy + 1, xx === 15 && shape.e ? shape.heights[1] : 0],
              [xx + 1, yy + 1, height],
              [xx + 1, yy, height],
            ],
            side: "side",
            material: "stone",
          });
        if (!occupied(xx, yy + 1))
          faces.push({
            vertices: [
              [xx, yy + 1, yy === 15 && shape.s ? shape.heights[2] : 0],
              [xx + 1, yy + 1, yy === 15 && shape.s ? shape.heights[2] : 0],
              [xx + 1, yy + 1, height],
              [xx, yy + 1, height],
            ],
            side: "front",
            material: "stone",
          });
      }
    return bake(faces, palette, variant, phaseX, phaseY, decoration);
  });
  c.drawImage(image, x - STRUCTURE_OVERHANG, y - STRUCTURE_RISE);
}
export function drawDoorSprite(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  type: string,
  vertical: boolean,
  palette: StonePalette,
  variation: number,
) {
  const key = `door:${type}:${vertical}:${palette.cap}:${variation % 4}`;
  const image = sprite(key, () => {
    const faces: Face[] = [];
    const add = (
      x0: number,
      y0: number,
      z0: number,
      x1: number,
      y1: number,
      z1: number,
      material: Material,
    ) => box(faces, x0, y0, z0, x1, y1, z1, material, vertical);
    // The same portal rotates into either wall direction. Its 10-unit wall
    // thickness exactly matches the neighboring wall mesh's central band.
    add(0, 3, 0, 2, 13, 24, "stone");
    add(14, 3, 0, 16, 13, 24, "stone");
    add(2, 3, 20, 14, 13, 24, "stone");
    if (type === "closedDoor") {
      // Mount the leaf at the visible face of the wall, not buried midway
      // through its thickness where the near jamb would conceal it.
      add(2, 12, 1, 14, 13, 20, "wood");
      add(11, 13, 9, 12, 14, 11, "brass");
    } else if (type === "openDoor") {
      add(2, 3, 1, 3, 13, 20, "wood");
      add(3, 4, 9, 4, 5, 11, "brass");
    }
    return bake(faces, palette, variation % 4, 0, 0);
  });
  c.drawImage(image, x - STRUCTURE_OVERHANG, y - STRUCTURE_RISE);
}

/** Original bedrock tile: irregular perimeter and eight sloping cap facets.
 * Shared edge heights use world vertices, so adjacent known rocks meet exactly.
 * All points remain inside the existing structure overhang/rise budget. */
export function drawRockSprite(
  c: CanvasRenderingContext2D, x: number, y: number, shape: WallShape,
  height: number, palette: StonePalette, variation: number, wx: number, wy: number,
) {
  const key = `rock:${JSON.stringify([shape,height,palette,variation,wx,wy])}`;
  const image = sprite(key, () => {
    const faces: Face[] = [];
    const edgeHeight = (px: number, py: number) => Math.max(3, height - 2 - hash(wx*16+px,wy*16+py,0)%3);
    // Joined edges retain common endpoints; unjoined edges pull inward.
    const n=shape.n?0:2+variation%2, e=shape.e?16:14-variation%2;
    const s=shape.s?16:14-(variation>>>2)%2, w=shape.w?0:2+(variation>>>3)%2;
    const ring: Point[] = [[3,n,0],[13,n,0],[e,3,0],[e,13,0],[13,s,0],[3,s,0],[w,13,0],[w,3,0]]
      .map(([px,py]) => [px!,py!,edgeHeight(px!,py!)] as Point);
    const peak: Point=[6+variation%5,6+(variation>>>4)%5,height];
    for(let i=0;i<ring.length;i++){
      const a=ring[i]!, b=ring[(i+1)%ring.length]!;
      faces.push({vertices:[a,b,peak],side:'top',material:'rock',tone:i<2?((variation>>>i)%3===0?1:0):i<5?2:1});
      // Vertical fractures descend to the footing; common-height seams occlude.
      faces.push({vertices:[[a[0],a[1],0],[b[0],b[1],0],b,a],side:i>=2&&i<4?'side':'front',material:'rock',tone:i%3});
    }
    return bake(faces,palette,variation%17,wx*16,wy*16);
  });
  c.drawImage(image,x-STRUCTURE_OVERHANG,y-STRUCTURE_RISE);
}
