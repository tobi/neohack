/** Original, native-pixel encounter silhouettes. Appearance is the only lookup key.
 * These are illustrations, never engine sizes, combat rules or hidden identities.
 */
export type CreaturePixels = {
  pixels: string[];
  body: string;
  shade: string;
  highlight?: string;
  rise?: number;
};
export const encounterArt: Record<string, CreaturePixels> = {
  "grid bug": {
    body: "#a0b384", shade: "#52685b", highlight: "#c6d9ad",
    pixels: ["#....#..", ".#..#...", "..##....", ".#ho#...", "#oss##..", ".####.#.", "#....#.."],
  },
  "giant ant": {
    body: "#ab7750", shade: "#654a3b",
    pixels: ["#......#....", ".#....#.....", "..####......", "..#ho#......", "##oss##.....", ".#ss#..#....", "..#hoo#.....", "##hooos##...", "..#sss#..#..", ".#.#.#......"],
  },
  "killer bee": {
    body: "#d5ae56", shade: "#6a5837", highlight: "#d2dccc", rise: 2,
    pixels: ["..##..##..", ".#hh##hh#.", "..##oo##..", "...#sso#..", "..#o#o#o#.", "...#sso#..", "....##...."],
  },
  "cave spider": {
    body: "#9f8882", shade: "#655863",
    pixels: ["#..#..#..#..", ".#.#..#.#...", "..######....", "###hoos###..", "..#osso#....", ".##ssss##...", "#..####..#..", "..#....#...."],
  },
  gecko: {
    body: "#a5b57c", shade: "#5a7252",
    pixels: ["......###...", ".....#hho#..", "..###oo#o#..", ".#hhoooo#...", "#os##os#....", "#s#..##.#...", ".##........."],
  },
  "garter snake": {
    body: "#83a26b", shade: "#4a654c", highlight: "#d8cc84",
    pixels: [".......###..", "......#ho#..", "......#o#o#.", "..####oss#..", ".#hhoooss#..", "#os#####....", "#oos####....", ".#hhooss#...", "..######...."],
  },
  fox: {
    body: "#c78e55", shade: "#76503b", highlight: "#ecdbbd",
    pixels: [".......#.#....", "......#o#o#...", "......#oo#o#..", "..###.#hhoo##.", ".#hoos#ooo##..", "#hhoooooss#...", "#h#oooosss#...", ".#..#os#os#...", "....##..##...."],
  },
  coyote: {
    body: "#b4a188", shade: "#766957",
    pixels: ["........##....", ".......#ho#...", ".......#o#o##.", "...####oooos#.", "..#hhoooo###..", ".#hooosss#....", "#s#oosssos#...", "#..#os#os#....", "...#s#.#s#....", "...##...##...."],
  },
  "floating eye": {
    body: "#86afb5", shade: "#50727e", highlight: "#e7e8d4", rise: 4,
    pixels: ["...####...", "..#hhhh#..", ".#hhoooh#.", "#hho##ooh#", "#hho##oos#", ".#hoooos#.", "..#ssss#..", "...####..."],
  },
  "gas spore": {
    body: "#bba16f", shade: "#786c4c", highlight: "#dfce93", rise: 3,
    pixels: ["..#..#..#...", "...#####....", ".##hhoos##..", "..#o#oos#...", "##hooo#ss##.", "..#oosoos#..", ".##ssss##...", "...####.....", "..#....#...."],
  },
  "acid blob": {
    body: "#a1af67", shade: "#5e754b", highlight: "#d6df9f",
    pixels: ["....####....", "..##hhoo#...", ".#hhoooos#..", "#hoosoooss#.", "#ooossssoss#", ".##########."],
  },
  "brown mold": {
    body: "#ac805a", shade: "#71563d", highlight: "#ccb58a",
    pixels: ["..##..###...", ".#ho##hoo#..", "#hhooossoo#.", ".#oosssos#..", "..##sss##...", "....###....."],
  },
};
