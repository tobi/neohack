# Pixel client

The selected asset library is **Modern Interiors — LimeZu**. Use the skill’s
Modern Interiors guide and `resources/tools/pixel` for room/prop work; do not
select DenPixelArt Dungeon. Existing masonry is an original renderer, not a
different approved asset pack.

Read [DESIGN.md](DESIGN.md) before visual or interaction changes, and maintain it
as the user's choices develop. This example is a client of the public library API;
all repository boundary, storage, licensing and verification rules still apply.

Keep only the 29 runtime PNGs listed in `art/recipe.json` under `public/art/`:
thirteen LimeZu character portrait/sheet pairs and three animal portraits. All
characters use 16×32 frames and bottom-center (8,32) anchors. Valkyrie and Wizard
use the original premade selections; Ranger uses its original layered preset.
Do not restore the retired 24×32 generated hero pilot or its build scripts.
Keep portable asset/layer identifiers and export parameters in the art recipes,
not public JSON sidecars or full vendor sheets. Preserve attribution and run
`node --test tests/assets.test.mjs` when changing the asset selection.

<!-- pixel-art:design-guidance -->
For visual, UI, scene and sprite work in this folder, read the linked DESIGN.md first.
Keep the selected tileset and approved design choices. Record new user decisions,
design notes, sprite-generation parameters and recipe/output links in DESIGN.md.
Do not switch packs or add incompatible assets without resolving the design choice.
