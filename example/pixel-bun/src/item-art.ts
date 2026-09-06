/** Original 12px item silhouettes. Select only from the engine's undecorated
 * perceived appearance, never labels, nicknames, slots or opaque references. */
export const itemPixels: Record<string, string[]> = {
  shield: [
    '............', '..########..', '.#hhhhhhhh#.', '.#hoooooss#.',
    '.#hoooooss#.', '.#hoooooss#.', '..#ooooss#..', '..#ooooss#..',
    '...#ooss#...', '....#ss#....', '.....##.....', '............',
  ],
  gloves: [
    '............', '..#.#.......', '.#h#h#..#.#.', '.#hhh#.#h#h#',
    '.#hhh#.#hhh#', '#ohhh#.#hhh#', '#ohhs#.#hhs#', '.#oos#.#oos#',
    '.#sss#.#sss#', '.#####.#####', '............', '............',
  ],
  boots: [
    '.####..####.', '.#hh#..#hh#.', '.#oo#..#oo#.', '.#oo#..#oo#.',
    '.#oo#..#oo#.', '.#oo#..#oo#.', '.#oo##.#oo##', '#oooh##oooh#',
    '#ssss##ssss#', '.#####.#####', '............', '............',
  ],
  helmet: [
    '............', '....####....', '...#hhhh#...', '..#hhhoos#..',
    '..#hhooos#..', '.#hhhoooss#.', '.#hhhoooss#.', '.##########.',
    '..#s#..#s#..', '..###..###..', '............', '............',
  ],
  cloak: [
    '....####....', '...#hhho#...', '..#hoooss#..', '...#hoss#...',
    '..#hhooss#..', '..#hoooss#..', '.#hhooooss#.', '.#hoooooss#.',
    '#hhooooooss#', '#hooooossss#', '.##########.', '............',
  ],
  mace: [
    '....####....', '...#hhoo#...', '..#hhooos#..', '..#hhooos#..',
    '...#ooss#...', '....####....', '.....#o#....', '.....#o#....',
    '.....#o#....', '.....#s#....', '.....###....', '............',
  ],
  chest: [
    '............', '..########..', '.#hhhhhhhs#.', '#hoooooooss#',
    '#hoooooooss#', '############', '#oooo##ooss#', '#oooohhooss#',
    '#ooooooooss#', '#ssssssssss#', '.##########.', '............',
  ],
};

export function itemSilhouette(category: string, appearance?: string): string | undefined {
  if (!appearance) return;
  if (category === 'armor') {
    if (/\bshield\b/.test(appearance)) return 'shield';
    if (/\b(gloves|gauntlets)\b/.test(appearance)) return 'gloves';
    if (/\b(boots|shoes)\b/.test(appearance)) return 'boots';
    if (/\b(helm|helmet|cap|hat)\b/.test(appearance)) return 'helmet';
    if (/\b(cloak|robe|cope|opera cloak)\b/.test(appearance)) return 'cloak';
    if (/\b(mail|armor|shirt|jacket)\b/.test(appearance)) return 'armor';
  }
  if (category === 'weapon') {
    if (appearance === 'mace') return 'mace';
    if (/\b(sword|dagger|knife|athame)\b/.test(appearance)) return 'weapon';
  }
  if (category === 'tool' && /^(chest|large box)$/.test(appearance)) return 'chest';
}
