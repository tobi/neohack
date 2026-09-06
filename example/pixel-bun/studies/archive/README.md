# LimeZu room composition study

The current recipe contains original masonry, the LimeZu rug-red, and the existing
Ranger/dog exports. It is an offline scale/composition study, not a game observation
or live placement algorithm. No collision or engine topology comes from it.

Run from `example/pixel-bun` with `PIXEL` set to the skill's
`resources/tools/pixel` executable:

```sh
bun scripts/render-dungeon.ts --layout studies/archive/room.txt --layout-type dungeon --seed 42 --scale 1 --out test-results/limezu-archive/stone-room.png
"$PIXEL" compose studies/archive/scene.json --scale 1 --out test-results/limezu-archive/composed-native.png
"$PIXEL" compose studies/archive/scene.json --scale 3 --out test-results/limezu-archive/composed.png
```

The renderer's side/top padding produces a native 416×272 canvas. Recipe coordinates
are native pixels. Character anchors are bottom-center, with foot-Y layer ordering.
The rug's bright palette remains a study, not an approved live raster decoration.

## Retained lessons from rejected furniture

Classroom-library shelves and their ladder were removed because they read as
supermarket furniture. Desks and the associated chair were removed because they
promise unsupported interaction. Their successful extraction did not establish
world fit. None of these props are selected by the current recipe or live profiles.

The inspected normal shelf/desk shadows included opaque pale pixels
RGBA (167,151,150,255), resembling foreign flooring on dark stone. At the same
sample, shadowless had alpha 0 and black-shadow used (58,58,80,100). Compare actual
variants on the destination floor, not a neutral contact sheet alone. Transparent
bottom padding also meant the frame's bottom was not the visible contact point.
Use the compose tool's fresh audit and visual inspection together.

Layout-specific selection lives in [art/layout-types](../../art/layout-types/README.md).
The continuous rear cap, two-cell tall east continuation and early low south return
are exercised in the renderer workshop. Local sprite cutaways have separate tests.

Only recipes are source. Images and discovery sheets stay in ignored test-results.
Credit: Modern Interiors by LimeZu, https://limezu.itch.io/moderninteriors.
See [LimeZu terms](../../art/LimeZu-LICENSE.txt).
