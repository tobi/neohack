# Original cave tileset · first rock study

Cave now selects `geometry: rock`: eight faceted cap triangles per 16px wall tile,
fractured vertical faces, seeded inward edge offsets and shared world-coordinate
heights at joins. The existing oblique projection and visibility cutaways apply.
Unpaved earth replaces the masonry floor; cracks, puddles and vines remain eligible.
There are no brick courses, mortar grids or dressed cap rims in this geometry.

Editable source: `src/structure-sprites.ts` (`drawRockSprite`) and
`src/dungeon-art.ts` (`earth`); palette and selection: this directory's profile.
Tiles bake to transparent native-resolution canvas sprites. This is original
project art, not a vendor cave pack or an exported LimeZu sheet. LimeZu remains
the approved character/prop library. Catalog searches for cave/rock returned no
named candidates; no other vendor pack was substituted.

Use `art/layouts/cavern.txt` for the organic-layout study and
`studies/archive/room.txt` for a controlled same-room comparison. Natural outlines
in the former are explicit offline inputs, never inferred gameplay geometry.
The gold diamond is a workshop location marker, not a new character asset.

The earlier cave palette survives as `dungeon-damp`. Cave selection remains
explicit; the live game still defaults to dungeon. Existing perceived stairs,
doors and other gameplay fixtures keep their readable symbols and construction.
The current scope is walls/floor, not new stalagmite objects or interactions.
