import { layoutProfile, type LayoutType } from "./layout-art";
/** Original native-pixel set dressing. No engine state or gameplay entities. */
export const AMBIENCE_VERSION = "room-ambience-1";
export const AMBIENCES = ["damp ruins", "abandoned quarters", "old archives", "rusted cells"] as const;
export type Decoration = "crack" | "puddle" | "straw" | "carpet" | "vines" | "shelf" | "chain" | "torch" | "scrap";
export function ambienceHash(seed: string | number, x = 0, y = 0, stream = "theme") {
  let h = 2166136261;
  for (const char of `${AMBIENCE_VERSION}:${seed}:${stream}:${x}:${y}`)
    h = Math.imul(h ^ char.charCodeAt(0), 16777619);
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  return (h ^ (h >>> 13)) >>> 0;
}
export function levelAmbience(seed: string | number) {
  return AMBIENCES[ambienceHash(seed) % AMBIENCES.length]!;
}
/** Broad coordinate districts add variation without using mutable room bounds. */
export function decorationAt(seed: string | number, x: number, y: number, wall: boolean, layoutType: LayoutType = "dungeon"): Decoration | undefined {
  const kind = candidateAt(seed,x,y,wall);
  return kind && layoutProfile(layoutType).decorations.includes(kind) ? kind : undefined;
}
function candidateAt(seed: string | number, x: number, y: number, wall: boolean): Decoration | undefined {
  const base = ambienceHash(seed) % 4;
  const district = ambienceHash(seed, Math.floor(x / 12), Math.floor(y / 9), "district");
  const theme = district % 4 === 0 ? (base + 1) % 4 : base;
  const choice = ambienceHash(seed, x, y, wall ? "wall" : "ground");
  if (wall) {
    // One possible fixture per three columns; no repeated wall of torches.
    if ((x % 3 + 3) % 3 !== ambienceHash(seed, 0, y, "spacing") % 3) return;
    return ([ ["vines", "vines", "torch"], ["torch", "chain", "vines"],
      ["shelf", "shelf", "torch"], ["chain", "chain", "torch"] ] as const)[theme]![choice % 3];
  }
  if (choice % 13 !== 0) return;
  return ([ ["puddle", "crack", "vines"], ["straw", "carpet", "crack"],
    ["carpet", "crack", "straw"], ["scrap", "crack", "straw"] ] as const)[theme]![((choice >>> 8) % 3)];
}

// Small editable pixel grids; dots are transparent. Props stay within a 16×16
// known floor footprint. Recessed fixtures occupy its rear edge, below actors.
const grids: Record<Decoration, readonly string[]> = {
  crack: ["..s........", "...s.......", "...s.......", "....ss.....", "......s....", ".....s.s...", "....s...ss.", "....s......"],
  puddle: ["...dddd....", ".dddddddd..", "ddwwwwdddd.", ".ddwwwllddd", "...dddddd.."],
  straw: ["....h......", ".h...h...h.", "..hh..h.h..", "....hhh....", "..hh.h.hh..", ".h....h...."],
  carpet: [".r..r..r..r...", "rrrrrrrrrrrrr.", "rbbrbbbbbbrbr.", "rbrbbbrbbbbrb.", "rbbbbrorbbbbr.", "rbrbbbrbb.br..", "rbbrbbbbbbrbr.", "rrrrrrrrr.rr..", ".r.r..r..r...."],
  vines: ["..m.....m...", "..m....mm...", ".mmm....m...", "..m...mmm...", "..mmm...m...", "...m....mm..", "...mm...m...", "...m........"],
  shelf: ["hhhhhhhhhhhh", "hssssssssssh", "hrgohrgorbsh", "hrgohrgorbsh", "hhhhhhhhhhhh", "hssrgobhsssh", "hhhrrgbhhhsh", "hhhhhhhhhhhh", ".ssssssssss."],
  chain: ["...ss......", "...ll......", "...sls.....", "....ls.....", "...sl......", "...ls......", "...sl......", "...sls.....", "....ss....."],
  torch: [".....a.....", "....aaa....", "....aca....", ".....c.....", "....lll....", ".....h.....", ".....h.....", ".....s....."],
  scrap: ["...........", "..ll.......", "...ll......", "....s..l...", "...h..ls...", "..h....ss.."],
};
const ink: Record<string, string> = { s: "#303832", d: "#364849", w: "#425554", l: "#727b69", h: "#75664b", r: "#71604c", b: "#544442", m: "#526347", a: "#b08343", c: "#d1b76c", o: "#8a7852", g: "#5f7464" };
export function drawDecoration(c: CanvasRenderingContext2D, kind: Decoration, x: number, y: number) {
  const grid = grids[kind];
  const ox = x + Math.floor((16 - grid[0]!.length) / 2), oy = y + 5;
  for (let py = 0; py < grid.length; py++)
    for (let px = 0; px < grid[py]!.length; px++) {
      const color = ink[grid[py]![px]!];
      if (!color) continue;
      c.fillStyle = color;
      c.fillRect(ox + px, oy + py, 1, 1);
    }
}

/** Sample original dressing on a vertical wall plane, in local world units. */
export function wallDecorationPixel(kind: Decoration, along: number, height: number, flame: number) {
  const grid = grids[kind];
  const py = 17 - Math.floor(height);
  const shift = kind === "torch" && py < 2 && flame === 2 ? 1 : 0;
  const px = Math.floor(along) - Math.floor((16 - grid[0]!.length) / 2) - shift;
  const key = grid[py]?.[px];
  if (key && ink[key]) return ink[key];
  if (kind === "torch" && height >= 10 && height < 15 && along >= 4 && along < 12)
    return flame === 1 ? "#6b5b3e" : "#5a503c";
  return undefined;
}
