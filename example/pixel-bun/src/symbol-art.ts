/** Original pixel silhouettes for public display categories, never item IDs.
 * A food token also covers remains; a canine token does not identify a species.
 * Source grids are editable assets. Each character is one native pixel.
 */
const icons: Record<string, string[]> = {
  food: [
    "............",
    "...####.....",
    "..#hhho#....",
    ".#hhoooo##..",
    "#hhooooooo#.",
    "#hooooooos#.",
    "#oooooosss#.",
    ".#ooossss#..",
    "..#sssss#...",
    "...#####....",
    "............",
    "............",
  ],
  coins: [
    "............",
    ".......###..",
    "......#hhh#.",
    "......#ooo#.",
    "..###..###..",
    ".#hhh#.#sss#",
    ".#ooo#..###.",
    ".#sss#.###..",
    "..###.#hhh#.",
    "......#ooo#.",
    ".......###..",
    "............",
  ],
  potion: [
    "....####....",
    "....#ss#....",
    "....#hh#....",
    "....#hh#....",
    "...#hhhh#...",
    "..#h.hhhh#..",
    "..#h.oooo#..",
    "..#hooooo#..",
    "..#ooooss#..",
    "..#oossss#..",
    "...######...",
    "............",
  ],
  scroll: [
    "..#######...",
    ".#hhhhhhs#..",
    ".#h####hs#..",
    "..#hhhhhs#..",
    "..#hsshhs#..",
    "..#hhhshs#..",
    "..#hsshhs#..",
    "..#hhhhhs#..",
    ".#hhhhhhhs#.",
    ".#h####hhs#.",
    "..#######...",
    "............",
  ],
  book: [
    "...#######..",
    "..#hooooo#..",
    ".#hhooooo#..",
    ".#soooooo#..",
    ".#sohhooo#..",
    ".#sohhooo#..",
    ".#soooooo#..",
    ".#sooooos#..",
    ".#shhhhh##..",
    ".#hhhhhh#...",
    "..######....",
    "............",
  ],
  weapon: [
    ".........##.",
    "........#h#.",
    ".......#hh#.",
    "......#hh#..",
    ".....#hh#...",
    "..#.#hs#....",
    "..#ohs#.....",
    "...#o#......",
    "..#s#o#.....",
    ".#s#..#.....",
    ".##.........",
    "............",
  ],
  armor: [
    "..##....##..",
    ".#hh####hh#.",
    "#hhhhoohhhs#",
    "#shhoooohss#",
    ".##hoooos##.",
    "..#hoooos#..",
    "..#hoooos#..",
    "..#hoooos#..",
    "..#hhhhhs#..",
    "...######...",
    "............",
    "............",
  ],
  ring: [
    "............",
    ".....##.....",
    "....#hh#....",
    "...#hoos#...",
    "..#hs##ss#..",
    "..#h#..#o#..",
    "..#h#..#o#..",
    "..#o#..#s#..",
    "...#oooo#...",
    "....####....",
    "............",
    "............",
  ],
  amulet: [
    "...#....#...",
    "...h....h...",
    "....h..h....",
    ".....hh.....",
    "....####....",
    "...#hhho#...",
    "..#hhhoos#..",
    "..#hoooss#..",
    "...#ooss#...",
    "....#ss#....",
    ".....##.....",
    "............",
  ],
  wand: [
    ".........#..",
    "........#h#.",
    ".......#ho#.",
    "......#oo#..",
    ".....#os#...",
    "....#os#....",
    "...#os#.....",
    "..#os#......",
    ".#hs#.......",
    ".#s#........",
    "..#.........",
    "............",
  ],
  gem: [
    "............",
    "...######...",
    "..#hhhhoo#..",
    ".#hhhhoooo#.",
    ".#hhhoooos#.",
    "..#hoooos#..",
    "...#ooos#...",
    "....#os#....",
    ".....##.....",
    "............",
    "............",
    "............",
  ],
  tool: [
    "............",
    "...######...",
    "..#hhhhhhs#.",
    "..#hs##sss#.",
    "...#s#..##..",
    "...#o#......",
    "...#o#......",
    "...#o#......",
    "...#s#......",
    "...###......",
    "............",
    "............",
  ],
  boulder: [
    "....#####...",
    "..##hhhho#..",
    ".#hhhhhhoo#.",
    ".#hhhhhhoos#",
    "#hhhhhoooss#",
    "#hhhooossss#",
    "#hoooosssss#",
    ".#oossssss#.",
    "..#ssssss#..",
    "...######...",
    "............",
    "............",
  ],
  unknown: [
    "............",
    "....####....",
    "...#hhho#...",
    "..#hhooos#..",
    "..#hoooos#..",
    "..#oossos#..",
    "...#ssos#...",
    "...#soos#...",
    "..#ssssss#..",
    "...######...",
    "............",
    "............",
  ],
  insect: [
    "..#......#..",
    "...#.##.#...",
    "....#hh#....",
    ".#..#oo#..#.",
    "..###ss###..",
    "...#hoos#...",
    ".##hoooos##.",
    "...#hoos#...",
    "..##ssss##..",
    ".#..####..#.",
    "............",
    "............",
  ],
  snake: [
    "............",
    ".......###..",
    "......#hho#.",
    "......#o#o#.",
    ".......#os#.",
    "...####oss#.",
    "..#hhhooos#.",
    ".#hoo#####..",
    ".#os#.......",
    "..#oooo###..",
    "...######...",
    "............",
  ],
  rodent: [
    "............",
    "....##..##..",
    "...#hh##hh#.",
    "...#hoooos#.",
    "..#hho#o#ss#",
    "..#hoooooss#",
    "..#hoooo#ss#",
    ".#hoooooos#.",
    "#.#ossss##..",
    "#..#s##s#...",
    ".##.........",
    "............",
  ],
  humanoid: [
    "....####....",
    "...#hhho#...",
    "...#hhoos#..",
    "...#o#o#s#..",
    "....#oss#...",
    "...######...",
    "..#hhoooos#.",
    "..#sooooss#.",
    "...#oooos#..",
    "...#ss#ss#..",
    "...#ss#ss#..",
    "...###.###..",
  ],
  ghost: [
    "....####....",
    "...#hhhh#...",
    "..#hhhhhh#..",
    "..#h#hh#h#..",
    "..#hhhhhh#..",
    "..#hhoohh#..",
    ".#hhhoohhh#.",
    ".#hhoooohh#.",
    ".#hooooosh#.",
    "..#osssos#..",
    "...##..##...",
    "............",
  ],
  blob: [
    "............",
    "............",
    "....####....",
    "...#hhhh#...",
    "..#hhhooos#.",
    "..#hhoooss#.",
    ".#hho#o#oss#",
    ".#hooooosss#",
    "#hooooossss#",
    "#ooooosssss#",
    ".##########.",
    "............",
  ],
};

const objectIcons: Record<string, string> = {
  "%": "food",
  $: "coins",
  "!": "potion",
  "?": "scroll",
  "+": "book",
  ")": "weapon",
  "[": "armor",
  "=": "ring",
  '"': "amulet",
  "/": "wand",
  "*": "gem",
  "(": "tool",
  "`": "boulder",
  "0": "boulder",
};
const creatureIcons: Record<string, string> = {
  a: "insect",
  x: "insect",
  s: "insect",
  S: "snake",
  r: "rodent",
  b: "blob",
  j: "blob",
  P: "blob",
  F: "blob",
  v: "ghost",
  " ": "ghost",
  "@": "humanoid",
  h: "humanoid",
  k: "humanoid",
  o: "humanoid",
  H: "humanoid",
  K: "humanoid",
  O: "humanoid",
  T: "humanoid",
  G: "humanoid",
  L: "humanoid",
  M: "humanoid",
  Z: "humanoid",
};

export function drawSymbolArt(
  c: CanvasRenderingContext2D,
  kind: "object" | "creature",
  mark: string,
  color: string,
  x: number,
  y: number,
  raised = false,
) {
  const icon =
    (kind === "object" ? objectIcons : creatureIcons)[mark] ?? "unknown";
  if (raised && icon === "boulder") {
    drawBoulder(c, x, y);
    return;
  }
  const main =
    icon === "food" ? "#b98058" : icon === "coins" ? "#d8ad56" : color;
  const palette: Record<string, string> = {
    "#": "#20282b",
    h: icon === "coins" ? "#ffe2a0" : "#d4c8a9",
    o: main,
    s: icon === "food" ? "#735142" : "#62645a",
  };
  for (const [row, pixels] of icons[icon]!.entries())
    for (const [col, pixel] of [...pixels].entries()) {
      if (pixel === ".") continue;
      c.fillStyle = palette[pixel]!;
      c.fillRect(x + 2 + col, y + 3 + row, 1, 1);
    }
}

/** A large rock-class silhouette, anchored at the tile foot. Its crown extends
 * above the floor cell; foreground ordering belongs to the map renderer. */
function drawBoulder(c: CanvasRenderingContext2D, x: number, y: number) {
  const rows = [
    ".......########........",
    ".....##hhhhhhhh##......",
    "....#hhhhhhhhhhhho#.....",
    "...#hhhhhhhhhhooooos#...",
    "..#hhhhhhhhhoooooooss#..",
    "..#hhhhhhhhooooooooss#..",
    ".#hhhhhhoooooooossssss#.",
    ".#hhhhhoooooooosssssss#.",
    "#hhhhooooooooossssssss#.",
    "#hhhoooosooooossssssss#.",
    "#hhooooossoooossssssss#.",
    "#hooooooosoooossssssss#.",
    "#oooooooossooossssssss#.",
    "#ooooooooosooossssssss#.",
    ".#oooooooooooosssssss#.",
    ".#ooooooooooossssssss#.",
    "..#ooooooooossssssss#..",
    "...#oooooosssssssss#...",
    "....##sssssssssss##....",
    "......###########......",
  ];
  const palette: Record<string, string> = {
    "#": "#293232",
    h: "#b5b4a0",
    o: "#838879",
    s: "#555f59",
  };
  c.fillStyle = "#202a27";
  c.fillRect(x - 2, y + 12, 22, 3);
  c.fillRect(x, y + 15, 18, 1);
  for (const [row, pixels] of rows.entries())
    for (const [col, pixel] of [...pixels].entries()) {
      if (pixel === ".") continue;
      c.fillStyle = palette[pixel]!;
      c.fillRect(x - 3 + col, y - 5 + row, 1, 1);
    }
}

const inventoryImages = new Map<string, string>();
export function categoryMark(category: string): string {
  return (
    (
      {
        weapon: ")",
        armor: "[",
        food: "%",
        potion: "!",
        scroll: "?",
        spellbook: "+",
        wand: "/",
        ring: "=",
        amulet: '"',
        tool: "(",
        gem: "*",
        coin: "$",
      } as Record<string, string>
    )[category] ?? ""
  );
}
export function inventoryArt(category: string): string {
  const cached = inventoryImages.get(category);
  if (cached) return cached;
  const mark = categoryMark(category);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 16;
  drawSymbolArt(canvas.getContext("2d")!, "object", mark, "#a9b39a", 0, 0);
  const url = canvas.toDataURL();
  inventoryImages.set(category, url);
  return url;
}

// Original editable creature pixels, independent of the private asset packs.
// The engine's apparent species selects art; glyph/color never supplies identity.
const earlyCreatures: Record<
  string,
  { pixels: string[]; body: string; shade: string }
> = {
  newt: {
    body: "#c1a66d",
    shade: "#76623e",
    pixels: [
      "............",
      "............",
      "......#####.",
      ".....#hhhoo#",
      "....#hho#oo#",
      "...#hhoooo#.",
      "..#hhooss#..",
      ".#hoooss#...",
      "#ooo##os##..",
      "#ss#..##..#.",
      ".##.........",
      "............",
    ],
  },
  jackal: {
    body: "#c09461",
    shade: "#79573d",
    pixels: [
      "..##...##...",
      "..#h#.#oh#..",
      "..#hh#hoo#..",
      "..#hhoooo#..",
      "..#o#oo#o#..",
      "...#hhoss#..",
      "...#oo#ss#..",
      "..#hooss#...",
      ".#hooooos#..",
      ".#ooossss#..",
      "..#os#os#...",
      "..###.###...",
    ],
  },
  lichen: {
    body: "#9dac65",
    shade: "#536a4b",
    pixels: [
      "............",
      "....###.....",
      "...#hho#....",
      "..##hoos##..",
      ".#hhoooohh#.",
      "#hhoosoooos#",
      "#ooossoooos#",
      ".#oossssos#.",
      "..#soosss#..",
      ".#hhooooss#.",
      ".#ssssssss#.",
      "..########..",
    ],
  },
  goblin: {
    body: "#91a76d",
    shade: "#4c6450",
    pixels: [
      "....####....",
      "...#hhho#...",
      "###hhoos###.",
      "#oo#o#o#oo#.",
      ".###oho###..",
      "...#ohhs#...",
      "..##ssss##..",
      ".#hsoooosh#.",
      ".#osssssso#.",
      "..#ooooss#..",
      "..#ss##ss#..",
      "..###..###..",
    ],
  },
  kobold: {
    body: "#b38b63",
    shade: "#725a43",
    pixels: [
      "....###.....",
      "...#hho#....",
      "..#hhoos#...",
      "..#o#o#os#..",
      "...#hhooos#.",
      "...#oo####..",
      "..##ssss#...",
      ".#hhoooos#..",
      ".#sooooos#..",
      "..#osssos#..",
      "..#os##os#..",
      "..###..###..",
    ],
  },
  "sewer rat": { body: "#a58a78", shade: "#655b57", pixels: icons.rodent! },
  "giant rat": { body: "#a99b83", shade: "#6f6759", pixels: icons.rodent! },
};
export function drawCreatureArt(
  c: CanvasRenderingContext2D,
  appearance: string | undefined,
  x: number,
  y: number,
): boolean {
  const art = appearance ? earlyCreatures[appearance] : undefined;
  if (!art) return false;
  const palette: Record<string, string> = {
    "#": "#1c2729",
    h: "#eadbb2",
    o: art.body,
    s: art.shade,
  };
  c.fillStyle = "#172321";
  c.fillRect(x, y + 14, 16, 2);
  for (const [row, pixels] of art.pixels.entries())
    for (const [col, pixel] of [...pixels].entries()) {
      if (pixel === ".") continue;
      c.fillStyle = palette[pixel]!;
      c.fillRect(x - 4 + col * 2, y - 8 + row * 2, 2, 2);
    }
  return true;
}
export function creatureArtUrl(
  appearance: string | undefined,
  mark: string,
): string {
  if (
    ["kitten", "housecat", "large cat"].includes(appearance ?? "") ||
    (!appearance && mark === "f")
  )
    return "/art/cat.png";
  if (
    ["little dog", "dog", "large dog"].includes(appearance ?? "") ||
    (!appearance && mark === "d")
  )
    return "/art/dog.png";
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  const c = canvas.getContext("2d")!;
  if (!drawCreatureArt(c, appearance, 8, 12))
    drawSymbolArt(c, "creature", mark, "#b6bba0", 8, 12);
  return canvas.toDataURL();
}
