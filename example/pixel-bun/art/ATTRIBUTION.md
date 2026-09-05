# Art and source terms

Modern Interiors art by LimeZu — https://limezu.itch.io/moderninteriors

`public/art/explorer.png` and `scholar.png` are the minimal, single-frame
`avatar-03` and `avatar-02` exports from the owner's private pixel-art-interfaces
library. `explorer-motion.png` and `scholar-motion.png` contain only the matching
premade characters' idle/walk rows (`[0,32,384,64]`); each direction has six native
16×32 frames. Source export metadata accompanies each PNG, and `recipe.json`
records direction order, timing and anchor. They are used in this finished
interface, not offered as a sprite pack.
The exact supplied terms are in [LimeZu-LICENSE.txt](LimeZu-LICENSE.txt).
Commercial/noncommercial project use and editing are permitted with credit;
reselling or redistributing the assets to others is prohibited. Do not treat this
repository as an unrestricted asset source or copy the private skill/catalog.
Clarify source-repository redistribution with the artist before a public release;
replace these character sprites with independently licensed art if needed. Free-to-play
does not make these assets open source.

`dog.png`, `cat.png` and `bat.png` are rendered from the skill's original editable
creature templates, copied here as matching JSON files. They are not LimeZu art.
No blanket license has been inferred for the original skill additions. The owner
must settle their distribution terms alongside the project-code licensing review.
Only the still portraits are used as class illustrations; procedural gameplay/AI
metadata is not used. A canine illustration represents the visible `d` symbol,
not a private species lookup.

The dungeon tiles, doorway illustration, layout and UI code were authored for
this example. `recipe.json` records their palette, geometry and provenance;
the editable renderers are `src/map.ts` and `src/dungeon-art.ts`. Other creature
and loot illustrations are original pixel grids in `src/symbol-art.ts`.
No external fonts or frontend libraries
are fetched. NetHack retains its original notices and NGPL terms; see
`../../lib/neonethack/NOTICE.md` from the example root.

To repeat the asset exports with the owner's skill installation:

```sh
PIXEL="$HOME/.agents/skills/pixel-art-interfaces/resources/tools/pixel"
"$PIXEL" export avatar-03 --out public/art/explorer.png
"$PIXEL" export avatar-02 --out public/art/scholar.png
"$PIXEL" export modern-premade-character-03 --rect 0 32 384 64 --out public/art/explorer-motion.png
"$PIXEL" export modern-premade-character-02 --rect 0 32 384 64 --out public/art/scholar-motion.png
"$PIXEL" entity --template dog --name Companion --color '#c79b67' --out /tmp/pixel-dog
"$PIXEL" entity --template bat --name Bat --out /tmp/pixel-bat
"$PIXEL" entity --template cat --name Feline --out /tmp/pixel-cat
# Copy only each portrait.png into public/art/{dog,bat,cat}.png.
```

The application runs/builds without the skill or its private source assets.
