# Art attribution

The runtime inventory and export parameters are listed in [recipe.json](recipe.json).

## Character art

Modern Interiors art by LimeZu — https://limezu.itch.io/moderninteriors

All thirteen classes use native 16×32 portraits and 384×64 idle/walk sheets.
Valkyrie uses Modern Interiors premade character 03; Wizard uses premade character
02. Ranger and the other ten classes use adult character generator layers.
[classes.json](classes.json) records premade asset IDs and selected layer
combinations; [recipe.json](recipe.json) records crops, geometry and animation.

The exact supplied terms are in [LimeZu-LICENSE.txt](LimeZu-LICENSE.txt).
Commercial/noncommercial project use and editing are permitted with credit;
reselling or redistributing the assets to others is prohibited. These
sprites require permission or replacement before public source distribution.

To rebuild all thirteen pairs with an authorized local exporter installation, set
`PIXEL` to its executable and run `node scripts/build-characters.mjs` from the
example. Full generated sheets and exporter sidecars stay in a temporary directory;
only the selected portrait and idle/walk PNGs are copied into `public/art/`.
Ordinary app builds use the included PNGs.

## Animal portraits and original drawing code

`dog.png`, `cat.png` and `bat.png` are single-frame outputs rendered from the
skill's original creature templates. They are not LimeZu art. Their raw template
JSON, pixel grids, palettes, generator code, motion exports and behavior metadata
are not included. `recipe.json` records only selected template names and export
parameters.

The dungeon tiles, doorway illustration, layout and UI code were authored for
this example. `recipe.json` records their palette, geometry and provenance;
the editable renderers are `src/map.ts`, `src/dungeon-art.ts` and
`src/structure-sprites.ts`. Creature and loot illustrations in `src/symbol-art.ts`
and the additional common-encounter silhouettes in `src/encounter-art.ts` are
original editable drawings for this example.

The equipment grids in `src/item-art.ts` and `src/equipment-pixels.ts` are
original project drawings, including the 24 weapon shapes and six statue
designs approved on 2026-09-08. Their exported review atlas is generated from
those editable grids; it contains no LimeZu or original NetHack tile pixels.

Project-code and original-art licensing is recorded in the repository's
[notices](../../../lib/neonethack/NOTICE.md).

## Runtime inventory

`public/art/` contains exactly **29 PNGs**:

| Files | Count | Use | Native size |
| --- | --- | --- | --- |
| Thirteen class portraits | 13 | HUD and starting-path cards | 16×32 |
| Thirteen matching `*-motion.png` sheets | 13 | Directional idle/walk clips; Ranger also supplies the welcome traveler | 384×64 |
| `dog.png`, `cat.png`, `bat.png` | 3 | Creature illustrations; dog also supplies the welcome companion and favicon | 16×16 |

Retired character exports, comparison inputs and HTML review reports are not part
of this source selection. Runtime files contain no JSON sidecars; portable
provenance remains in `art/`. `tests/assets.test.mjs` checks the explicit runtime
and source inventories, PNG geometry and recipe integrity.
Browser tests separately exercise the selected client art.

## Optional sound effects

Four unmodified clips from [Kenney RPG Audio](https://kenney.nl/assets/rpg-audio)
by Kenney Vleugels: footstep00, footstep01, creak1 and chop. These are CC0;
[the supplied license](../public/audio/Kenney-LICENSE.txt) and
[selection provenance](../public/audio/README.md) accompany them.

Original cave environment: faceted rock sprite meshes and procedural earth in
`src/structure-sprites.ts` and `src/dungeon-art.ts`, with editable palette under
`art/layout-types/cave/`. Original project work; no vendor cave pixels or raw
LimeZu environment assets are included in these generated tiles.

The creature family masters, size/palette recipes and uncertain-creature cloud in
`src/creature-families.ts`, `src/creature-presets.ts` and `src/symbol-art.ts` are
original neohack pixel artwork. They extend the existing original encounter grids.
The appearance mapping derives names and drawing groups from the pinned NetHack
source; NetHack notices and NGPL attribution remain in the engine distribution.

The rigid-container master and prone death impressions in `src/item-art.ts` and
`src/death-traces.ts` are original neohack pixel compositions. Impressions reuse
only already disclosed creature artwork and are decorative, not engine objects.
