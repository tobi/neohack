/** Explicit workshop syntax. This parses an art input, never an engine save. */
import type { TerrainCell } from "../src/dungeon-art.ts";

export const LEGEND: Readonly<Record<string, string>> = {
  " ": "unknown",
  "|": "wall",
  "-": "wall",
  ".": "floor",
  "#": "corridor",
  "+": "closedDoor",
  D: "closedDoor",
  "/": "openDoor",
  d: "openDoor",
  "<": "stairsUp",
  ">": "stairsDown",
  "~": "water",
  "{": "fountain",
  _: "altar",
  "@": "floor",
  "^": "trap",
  "}": "lava",
  T: "tree",
  '"': "grass",
  I: "ice",
  "=": "bars",
  "\\": "throne",
  K: "sink",
  "]": "bridge",
  X: "grave",
};

export function parseLayout(source: string) {
  if (source.includes("\r") && !source.includes("\r\n"))
    throw new Error("Use LF or CRLF line endings.");
  const lines = source.replaceAll("\r\n", "\n").replace(/\n$/, "").split("\n");
  const columns = Math.max(...lines.map((line) => line.length)),
    rows = lines.length;
  if (!columns || columns > 160 || rows > 100)
    throw new Error("Layout must contain 1–160 columns and 1–100 rows.");
  const cells: TerrainCell[] = [],
    actors: { x: number; y: number; mark: string }[] = [];
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < lines[y]!.length; x++) {
      const mark = lines[y]![x]!,
        type = LEGEND[mark];
      if (type === undefined)
        throw new Error(
          `Unsupported layout symbol ${JSON.stringify(mark)} at line ${y + 1}, column ${x + 1}. See art/README.md for the explicit legend.`,
        );
      if (type !== "unknown") cells.push({ x, y, terrain: { type,
        ...(["closedDoor", "openDoor"].includes(type)
          ? { orientation: mark === "D" || mark === "d" ? "vertical" as const : "horizontal" as const } : {}),
      } });
      if (mark === "@") actors.push({ x, y, mark });
    }
  return { columns, rows, cells, actors };
}
