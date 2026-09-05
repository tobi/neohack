# Art and source terms

This example uses three distinct art sources. The selected runtime files are
listed in [recipe.json](recipe.json); they are finished-project exports, not an
asset pack or permission to redistribute the private skill library.

## LimeZu class prototypes

Modern Interiors art by LimeZu — https://limezu.itch.io/moderninteriors

The Archeologist, Barbarian, Caveman, Healer, Knight, Monk, Priest, Rogue, Samurai
and Tourist each use one 16×32 portrait and one 384×64 idle/walk sheet, composed
from the owner's LimeZu adult generator layers. [classes.json](classes.json)
records the ten selected layer combinations; it contains identifiers, not vendor
pixels. `recipe.json` records output selection, crop rectangles, frame geometry,
direction order, timing and anchors. No raw layers, full generator sheets,
private templates, catalogs, tools or public export JSON sidecars are included.

The exact supplied terms are in [LimeZu-LICENSE.txt](LimeZu-LICENSE.txt).
Commercial/noncommercial project use and editing are permitted with credit;
reselling or redistributing the assets to others is prohibited. Do not treat this
repository as an unrestricted asset source or copy the private skill/catalog.
Clarify source-repository redistribution with the artist before a public release;
replace these class prototypes with independently licensed art if needed.
Free-to-play and minimal cropping do not make these assets open source.

To rebuild these ten pairs with an authorized local skill installation, set
`PIXEL` to its executable and run `node scripts/build-characters.mjs` from the
example. Full generated sheets and exporter sidecars stay in a temporary directory;
only the selected portrait and idle/walk PNGs are copied into `public/art/`.
Ordinary app builds do not require this private art tool.

## Original heroes

`public/art/{valkyrie,wizard,ranger}-original.png` and the matching
`*-original-motion.png` sheets are newly generated original character designs.
They were created with the built-in image_gen tool and normalized into editable
pixel grids, without compositing or deriving from LimeZu sprites. The tool did
not report a model version or seed.

The ten files in [original-heroes/](original-heroes/README.md) are original project
source, not raw assets copied from the skill: one README, three exact prompts,
three untouched generated source PNGs and three editable JSON frame recipes.
The recipes preserve source hashes, normalization, palette and registration.
They must remain alongside the final exports. The selected 24×32 frames use a
common 27-color palette, static directional idle holds and six-pose walking clips.
Their packed runtime sheets are 576×64. `scripts/build-original-heroes.mjs`
rebuilds the six runtime PNGs without an image-generation API or private skill.

No blanket publication or code/art license is assigned by this work; the
repository owner retains that decision.

## Animal portraits and original drawing code

`dog.png`, `cat.png` and `bat.png` are single-frame outputs rendered from the
skill's original creature templates. They are not LimeZu art. Their raw template
JSON, pixel grids, palettes, generator code, motion exports and behavior metadata
are not included. `recipe.json` records only selected template names and export
parameters. No blanket license has been inferred for the original skill additions;
the owner must settle the finished exports' distribution terms alongside the
project-code licensing review.

The dungeon tiles, doorway illustration, layout and UI code were authored for
this example. `recipe.json` records their palette, geometry and provenance;
the editable renderers are `src/map.ts`, `src/dungeon-art.ts` and
`src/structure-sprites.ts`. Creature and loot illustrations in `src/symbol-art.ts`
and the additional common-encounter silhouettes in `src/encounter-art.ts` are
original editable drawings for this example, not copied vendor templates. Their
publication and licensing remain part of the owner's original-code/art decision.

The game fetches no external fonts or frontend libraries. NetHack retains its
original notices and NGPL terms; see `../../lib/neonethack/NOTICE.md` from the
example root.

## Minimal finished-project selection

`public/art/` contains exactly **29 PNGs**:

| Files | Count | Use | Native size |
| --- | --- | --- | --- |
| Ten class prototype portraits | 10 | HUD and starting-path cards | 16×32 |
| Ten matching `*-motion.png` sheets | 10 | Directional idle/walk clips | 384×64 |
| Three `*-original.png` hero portraits | 3 | Valkyrie, Wizard and Ranger HUD/cards | 24×32 |
| Three `*-original-motion.png` sheets | 3 | Original hero movement; Ranger also supplies the welcome traveler | 576×64 |
| `dog.png`, `cat.png`, `bat.png` | 3 | Creature illustrations; dog also supplies the welcome companion and favicon | 16×16 |

Retired character exports, comparison inputs and HTML review reports are not part
of this source selection. Runtime files contain no JSON sidecars; portable
provenance remains in `art/`. `tests/assets.test.mjs` checks the explicit runtime
and source inventories, PNG geometry, original-source hashes and recipe integrity.
Browser tests separately exercise the selected client art.

Minimizing the files does not change their licenses. Deleted files also remain
in private Git history; do not publish that history as a cleanup shortcut.
