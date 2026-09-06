# Layout-specific art

Each layout type owns its approved geometry, surface palette and dressing:

- `defaults/profile.json`: shared masonry geometry, stone palettes and incidental dressing.
- `dungeon/profile.json`: worn masonry; no modern shelves or unusable desks.
- `dungeon-damp/profile.json`: the former palette-only cave, preserved as a damp dungeon variant.
- `cave/profile.json`: original faceted rock geometry, earth and restricted natural dressing.

`src/layout-art.ts` resolves defaults followed by the selected profile. Omitted
fields inherit; arrays replace the default array completely. An empty decorations
array disables dressing. Unknown profile names are rejected. The shared live and
workshop renderer consumes these profiles, including palette selection for doors.
Keep future approved raster assets and portable export recipes beside their
layout profile; none are integrated as layout furniture yet.

Use `art:render --layout-type dungeon`, `--layout-type dungeon-damp` or
`--layout-type cave` on the same layout and seed to compare. Terrain clients can
pass `layoutType` and use the matching type for their separate door pass. The game
uses dungeon by default. Never infer hidden cave membership or change gameplay
terrain to fit cosmetic art. The [cave recipe](cave/README.md) documents the first
rock tileset and its remaining shared-fixture limitations.

LimeZu Modern Interiors remains the character/prop asset library. A library is a
source to inspect, not a promise that every asset belongs in every world. Evaluate
silhouette, material, wear, palette, perspective, native scale and interaction cues
per layout. Bright regular archive shelves were rejected as supermarket-like.
Desks were rejected because they promise unsupported interaction. Neither belongs
in defaults. Cave walls and earth extend the project's original environment art;
no alternative vendor pack has been substituted. Preserve runtime inventory and
attribution checks when adding future selected assets.

Live activation: `layoutForSeed` now selects one of the three completed profiles
from the existing game-seed/public-location key. The map uses that same selection
for terrain and its separate door pass. This cosmetic assignment does not claim
an engine biome. The renderer's standalone default remains dungeon; live play
uses all three. Revisits retain their seeded appearance.
