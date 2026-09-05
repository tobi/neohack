# Art and source terms

Modern Interiors art by LimeZu — https://limezu.itch.io/moderninteriors

`public/art/explorer.png` and `scholar.png` are the minimal, single-frame
`avatar-03` and `avatar-02` exports from the owner's private pixel-art-interfaces
library. `explorer-motion.png` and `scholar-motion.png` contain only the matching
premade characters' idle/walk rows (`[0,32,384,64]`); each direction has six native
16×32 frames. `recipe.json` records the selected export IDs, crop rectangles,
direction order, timing and anchor; there are no public export JSON sidecars.
They are used in this finished interface, not offered as a sprite pack.
The exact supplied terms are in [LimeZu-LICENSE.txt](LimeZu-LICENSE.txt).
Commercial/noncommercial project use and editing are permitted with credit;
reselling or redistributing the assets to others is prohibited. Do not treat this
repository as an unrestricted asset source or copy the private skill/catalog.
Clarify source-repository redistribution with the artist before a public release;
replace these character sprites with independently licensed art if needed. Free-to-play
does not make these assets open source.

`dog.png`, `cat.png` and `bat.png` are the single-frame outputs rendered from the
skill's original creature templates. They are not LimeZu art. The raw template
JSON, pixel grids, palettes, generator code, motion exports and behavior metadata
are not included. `recipe.json` records only the selected template and export
parameters. No blanket license has been inferred for the original skill additions;
the owner must settle the finished exports' distribution terms alongside the
project-code licensing review. Only these still portraits are used as class
illustrations. A canine illustration represents the visible `d` symbol, not a
private species lookup.

The dungeon tiles, doorway illustration, layout and UI code were authored for
this example. `recipe.json` records their palette, geometry and provenance;
the editable renderers are `src/map.ts` and `src/dungeon-art.ts`. Other creature
and loot illustrations are original pixel grids in `src/symbol-art.ts`.
No external fonts or frontend libraries
are fetched. NetHack retains its original notices and NGPL terms; see
`../../lib/neonethack/NOTICE.md` from the example root.

## Minimal finished-project selection

`public/art/` contains only the seven PNGs the client loads:

| Files | Use | Native size |
| --- | --- | --- |
| `explorer.png`, `scholar.png` | HUD portrait and starting-path cards | 16×32 |
| `explorer-motion.png`, `scholar-motion.png` | Welcome traveler and game character idle/walk clips | 384×64 |
| `dog.png`, `cat.png`, `bat.png` | Visible creature illustrations; dog also supplies the welcome companion and favicon | 16×16 |

There are no raw skill assets, full vendor sheets, catalogs, pack archives,
private tools or editable skill templates in this selection. Original drawing
code authored for this example remains editable. Source selection and PNG
geometry are checked by `tests/assets.test.mjs`; browser tests check that the
client loads all seven exports and does not serve removed source metadata.

The application runs/builds without the skill or its private source assets.
Minimizing the files does not change their license: public-source redistribution
still needs the permission or replacement described above. Deleted files also
remain in private Git history; do not publish that history as a cleanup shortcut.
