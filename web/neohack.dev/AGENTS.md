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

## Reusable interface components

Prefer small reusable **Lit web components** for recurring UI, extracting them
as a screen is improved rather than adding another copy of its markup/handlers.
The searchable `neohack-action-menu` in `src/action-menu.ts` is the first example:
it owns presentation and selection; its caller owns the game and guarded actions.

Good candidates for reuse:
- Action buttons: native button semantics, icon/label, visible shortcut badge,
  disabled explanation and busy state. One action definition must drive its
  label, shortcut display and keyboard handler.
- Searchable action/item menus: focused search, substring and command matches,
  arrow navigation, explicit Enter/click, and a scrolling result region.
- Dialog shells: native `<dialog>`, compact fixed header/footer, scrolling body,
  Escape policy and focus restoration. Engine decisions supply cancellation rules.
- Shortcut hints, item rows and stat pairs: consistent spacing, accessible names
  and shared styles across map options, inventory and settings.

These are extraction guidelines, not claims that every component already exists.
Keep ordinary form controls native; custom elements must retain labels, disabled
behavior, form submission and keyboard access. Use typed properties/events;
components never fetch hidden game facts, own global gameplay shortcuts, confirm
warnings or turn an uncertain result into a retry. Prefer Lit templates over HTML
string assembly. Use light DOM when native labeling/focus or the shared stylesheet
needs it; use shadow DOM deliberately, with explicit styling and accessibility.

Use the shared control size/spacing tokens. Compact text buttons are 36px on
desktop; phones/coarse pointers retain at least 44px targets. Icon buttons and
direction pads keep their dedicated touch geometry. Always show assigned hotkeys;
scope them to the active surface, and never let typing in a field move the hero.
Test focus, typing, disabled/stale actions, touch layout and viewport overflow in
the real browser when extracting interaction components.
