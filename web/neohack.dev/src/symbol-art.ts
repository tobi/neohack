import { creaturePixels, companionAsset } from "./creature-families";
import { itemPixels, itemSilhouette } from "./item-art";
import { equipmentPixels, drawEquipment } from "./equipment-pixels";

/** Original pixel silhouettes for public display categories, never item IDs.
 * A food token also covers remains. Creature art uses disclosed appearance only.
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
export function drawObjectArt(
  c: CanvasRenderingContext2D,
  mark: string,
  color: string,
  x: number,
  y: number,
  raised = false,
) {
  const icon = objectIcons[mark] ?? "unknown";
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
type IllustratedItem = { category?: string; known?: { appearance?: string; depictedCreature?: string } };

/** Draw the same perceived item shape in world, inventory and HUD. */
export function drawItemArt(c: CanvasRenderingContext2D, item: IllustratedItem, x = 0, y = 0): boolean {
  const silhouette = itemSilhouette(item.category ?? '', item.known?.appearance, item.known?.depictedCreature);
  if (!silhouette) return false;
  if (equipmentPixels[silhouette]) drawEquipment(c, silhouette, x, y);
  else {
    const palette: Record<string, string> = { '#': '#20282b', h: '#d4c8a9', o: ['chest','box'].includes(silhouette) ? '#a77c52' : silhouette === 'iceBox' ? '#b9c7bc' : '#a9b39a', s: '#62645a' };
    const grid=itemPixels[silhouette] ?? icons[silhouette]!;
    const left=x+Math.floor((16-grid[0]!.length)/2),top=y+14-grid.length;
    for (const [row, pixels] of grid.entries())
      for (const [col, pixel] of [...pixels].entries()) if (pixel !== '.') {
        c.fillStyle = palette[pixel]!;
        c.fillRect(left + col, top + row, 1, 1);
      }
  }
  return true;
}

export function inventoryArt(item: IllustratedItem & {category: string}): string {
  const { category } = item;
  const silhouette = itemSilhouette(category, item.known?.appearance, item.known?.depictedCreature);
  const key = `${category}:${silhouette ?? "category"}`;
  const cached = inventoryImages.get(key);
  if (cached) return cached;
  const mark = categoryMark(category);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 16;
  const c = canvas.getContext("2d")!;
  if (drawItemArt(c, item)) {
    // Shared world and inventory artwork has been drawn.
  } else if (['weapon', 'armor', 'tool'].includes(category)) {
    // A class glyph does not pretend an unsupported item is a sword or shirt.
    c.fillStyle = '#d4c8a9';
    c.font = 'bold 14px monospace';
    c.textAlign = 'center';
    c.fillText(mark, 8, 13);
  } else drawObjectArt(c, mark, "#a9b39a", 0, 0);
  const url = canvas.toDataURL();
  inventoryImages.set(key, url);
  return url;
}

export function drawCreatureArt(
  c: CanvasRenderingContext2D,
  appearance: string | undefined,
  x: number,
  y: number,
): boolean {
  const art = creaturePixels(appearance);
  if (!art) return false;
  const palette: Record<string, string> = {
    "#": "#1c2729",
    h: art.highlight ?? "#eadbb2",
    o: art.body,
    s: art.shade,
  };
  c.fillStyle = "#172321";
  const width = art.pixels[0]!.length;
  const left = x + Math.floor((16 - width) / 2);
  const top = y + 15 - art.pixels.length - (art.rise ?? 0);
  c.fillRect(left + 1, y + 14, width - 2, 1);
  for (const [row, pixels] of art.pixels.entries())
    for (const [col, pixel] of [...pixels].entries()) {
      if (pixel === ".") continue;
      c.fillStyle = palette[pixel]!;
      c.fillRect(left + col, top + row, 1, 1);
    }
  return true;
}
/** One neutral silhouette for every uncertain appearance, independent of glyph/color. */
export function drawUnknownCreature(c: CanvasRenderingContext2D, x: number, y: number) {
  const pixels = ['.....ssss.......','...sshhhhs......','..shhhhhhhsss...','.shhhooooohhhs..','shhhooooooooohs.','shoooooooooooss.','.ssoooooooooss..','...sssssssss....'];
  const palette: Record<string,string> = {s:'#667977',h:'#b8c6bd',o:'#94a6a0'};
  for (const [row,line] of pixels.entries()) for(const [col,p] of [...line].entries())
    if(p!=='.'){c.fillStyle=palette[p]!;c.fillRect(x+col,y+6+row,1,1);}
}
export function drawCreatureQuestion(c: CanvasRenderingContext2D, x:number,y:number) {
  c.fillStyle='#182128'; c.fillRect(x+11,y-7,8,11);
  c.fillStyle='#f1dfac';
  for(const [dx,dy,w,h] of [[12,-6,6,2],[16,-4,2,2],[14,-2,3,2],[14,1,2,2]])
    c.fillRect(x+dx!,y+dy!,w!,h!);
}
export function creatureArtUrl(appearance: string | undefined, _mark?: string): string {
  const asset=companionAsset(appearance);
  if(asset)return `/art/${asset}.png`;
  const canvas=document.createElement('canvas');canvas.width=canvas.height=64;
  const c=canvas.getContext('2d')!;
  c.scale(2,2);
  if(!drawCreatureArt(c,appearance,8,16)){
    drawUnknownCreature(c,8,16);drawCreatureQuestion(c,8,16);
  }
  return canvas.toDataURL();
}
