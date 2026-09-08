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
  chest: [
    '............', '..########..', '.#hhhhhhhs#.', '#hoooooooss#',
    '#hoooooooss#', '############', '#oooo##ooss#', '#oooohhooss#',
    '#ooooooooss#', '#ssssssssss#', '.##########.', '............',
  ],
};

export function itemSilhouette(category: string, appearance?: string, depictedCreature?: string): string | undefined {
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
    if (/\bmace\b/.test(appearance)) return 'mace';
    if (appearance === 'dart') return 'dart';
    if (appearance === 'throwing star') return 'throwingStar';
    if (appearance === 'boomerang') return 'boomerang';
    if (appearance === 'trident') return 'trident';
    if (appearance === 'broad pick') return 'pick';
    if (appearance === 'morning star') return 'morningStar';
    if (appearance === 'flail') return 'flail';
    if (appearance === 'sling') return 'sling';
    if (appearance === 'worm tooth') return 'tooth';
    if (appearance === 'crysknife') return 'dagger';
    if (appearance === 'rubber hose') return 'whip';
    if (/\b(arrow|bolt|ya)\b/.test(appearance)) return 'arrow';
    if (/\b(dagger|knife|athame|stiletto|scalpel)\b/.test(appearance)) return 'dagger';
    if (/\b(scimitar|saber|katana|tsurugi|curved sword|samurai sword)\b/.test(appearance)) return 'curvedBlade';
    if (/\b(sword|broadsword|runesword|wakizashi|ninja-to)\b/.test(appearance)) return 'sword';
    if (/\b(battle-axe|double-headed axe)\b/.test(appearance)) return 'battleAxe';
    if (/\baxe\b/.test(appearance)) return 'axe';
    if (/\bcrossbow\b/.test(appearance)) return 'crossbow';
    if (/\b(bow|yumi)\b/.test(appearance)) return 'bow';
    if (/\b(spear|javelin|lance)\b/.test(appearance)) return 'spear';
    if (/\b(halberd|bardiche|glaive|ranseur|partisan|fauchard|guisarme|bill-guisarme|bec de corbin|lucern hammer|voulge|poleaxe|polearm|pole cleaver|pole sickle|pruning hook)\b/.test(appearance)) return 'polearm';
    if (/\b(hammer|mallet)\b/.test(appearance)) return 'hammer';
    if (/\b(club|aklys)\b/.test(appearance)) return 'club';
    if (/\b(quarterstaff|staff)\b/.test(appearance)) return 'staff';
    if (/\b(bullwhip|whip)\b/.test(appearance)) return 'whip';
  }
  if (category === 'object' && appearance === 'statue') {
    // A structured perceived subject, never a label or the glyph's letter.
    const subject = depictedCreature ?? '';
    if (/\b(dog|puppy|wolf|jackal|fox|coyote|dingo|warg|hell hound)\b/.test(subject)) return 'statueCanine';
    if (/\b(cat|housecat|kitten|feline|tiger|jaguar|panther|lynx)\b/.test(subject)) return 'statueFeline';
    if (/\b(raven|bird|chickatrice|cockatrice)\b/.test(subject)) return 'statueBird';
    if (/\b(snake|cobra|python|pit viper)\b/.test(subject)) return 'statueSerpent';
    if (/\bdragon\b/.test(subject)) return 'statueDragon';
    return 'statue';
  }
  if (category === 'tool' && /^(chest|large box)$/.test(appearance)) return 'chest';
}
