# Pixel NetHack: a place worth descending into

## Selected art library — Modern Interiors by LimeZu

**Modern Interiors — LimeZu is the selected asset pack for this client.**
The user reaffirmed this choice on 2026-09-06. Use its asset discovery, contact
sheets, scene/compose tools and character generator for room and sprite work.
Do not choose DenPixelArt Dungeon because the game is a dungeon. Its reference
study was a mistaken pack selection and has been removed; it is not an approved
alternative, extension or future direction.

### What comes from where

- **People:** all thirteen character selections use LimeZu Modern Interiors,
  through premade characters or its layered adult character generator. Exact
  selections are in [art/classes.json](art/classes.json) and
  [art/recipe.json](art/recipe.json). Frames are 16×32, anchored at (8,32).
- **Room and prop asset work:** start with Modern Interiors and its dedicated
  tools. Browse actual asset/contact images before choosing crops. Use composed
  room studies to establish furniture scale, grouping, shadows and clear paths.
  Select art appropriate to NetHack: wood, stone, fabric, books and shelving;
  choosing this library does not make modern appliances appropriate.
- **Dungeon geometry:** current walls, doors, floors and wear are original code
  in `src/structure-sprites.ts`, `src/dungeon-art.ts` and `src/ambience.ts`.
  They are not LimeZu environment tiles. Preserve the established 16px ground
  grid and oblique projection; inspect props against these walls before
  integration. A pack selection is not a renderer swap.
- **Existing exceptions:** original dog/cat/bat templates and original encounter
  pixel grids remain approved. Kenney sound effects are a separate audio source.
  These do not authorize another environment pack.

### Required workflow for visual work

1. Read this selection and the pixel-art-interfaces skill's
   `references/packs/modern-interiors.md`. Use `resources/tools/pixel`, not
   the DenPixelArt `dungeon` or `create-entity` tools. Read the LimeZu character
   guide for humanoids and scene-recipe guidance before composition.
2. Search and inspect Modern Interiors assets; use contact sheets and the
   scene/compose tools to make an editable room study. Inspect available suitable
   authored assets before drawing replacement props by hand.
3. Review the study at native and integer scale beside our hero and masonry.
   Check perspective, palette, scale, layering and contact shadows.
4. Export only selected project assets with portable recipes and existing
   [LimeZu terms and attribution](art/ATTRIBUTION.md). Keep full vendor sheets,
   private catalogs and exploratory exports out of public/source bundles.
5. Keep this record and [.pixel-art.json](.pixel-art.json) consistent. Maintain
   the runtime inventory and AGENTS.md when asset selections change.
   A different base pack requires an explicit user-requested change.

The machine-readable selection below describes the asset library; the original
renderer geometry is recorded separately in `.pixel-art.json` and below. Idle
playback rate 1 means normal playback of the existing six-fps clips, not a new
animation speed. Walk clips remain ten fps; reduced motion uses static idle.

## Pixel-art style selection

<!-- pixel-art:style:start -->
- Base tileset: `modern-interiors`
- Pack guide: `references/packs/modern-interiors.md` (relative to the global skill)
- Projection: orthogonal furnished interiors
- Native tile size: [16, 16]
- Approved external modules: original-creatures
- Idle playback rate: 1
<!-- pixel-art:style:end -->


## The destination

A small, lovingly drawn world with real depth: heavy stone walls, worn floors,
quiet pools of lantern light, and an unmistakable sense that someone built these
rooms before the adventurer arrived. A compact HUD and field notes on demand keep the interface out of the world. It makes NetHack approachable without making its
choices for the player.

This is the visual target, not a claim that every feature below is implemented.
The first interface is a foundation. The dungeon art must develop beyond uniform
flat square tiles before we call it finished.

## View, geometry and depth

- Fixed three-quarter pixel view. Bake 3D masonry with an oblique projection
  that preserves NetHack's square ground grid and eight directions. There is no
  perspective scaling or isometric input mapping.
- World cells use a native 16×16 footprint. All characters use 16×32 figures
  with a stable bottom-center (8,32) anchor. Display at integer scales; disable canvas smoothing.
- **Walls have height.** Draw distinct top/cap planes, dark vertical faces,
  lighter upper edges, courses of masonry and a small ground-contact shadow.
  Corners, intersections, door jambs and narrow corridors must connect plausibly.
  Use neighbor masks to select geometry, not a disconnected cube per cell.
- Full walls rise 15 screen pixels; foreground cutaways rise about five. Keep passages readable;
  shadows or a foreground wall must never erase a known doorway or occupant.
  Actors and meaningful objects remain identifiable, with selection markers and
  text descriptions where geometry overlaps.
- Lighting consistently comes from the upper left. Ambient light is restrained.
  Real fountains, water, stairs and doors get their own silhouettes. Their visual
  footprints do not create new collision or interaction rules.

## Art direction

Charcoal blue-black void; desaturated olive-gray stone; warm cream text; sage
selection; amber firelight. Use a small related palette per room/region rather
than random rainbow tiles. Add interest through shape, depth and wear first.

The walls should suggest hand-laid blocks, an occasional repaired course, moss
along damp edges, and strong piers around thresholds. Floors should have larger
slabs mixed with small repairs, seams that join, chipped corners and sparse grit.
Avoid a regular checkerboard of identical outlined tiles. Corridors feel more
trodden and confined than open rooms.

No smooth gradients, blurred shadows, glass panels or vector emoji masquerading
as pixel art. Shade with hard pixel clusters and carefully limited dithering.
Keep text and controls as accessible HTML. Prefer readable 14–16px body text;
small metadata must remain secondary, never the only source of an instruction.

## Deterministic variety from the actual game seed

The example chooses or accepts an explicit seed at creation and passes it to the
engine. Store that same seed with the adventure's display metadata. Derive an
art seed from `(game seed, public level ID, renderer version)`. Derive independent
substreams for materials, wear, trims and accents so adding one detail does not
shuffle every other detail.

Use integer hashes of world coordinates for fine variation. Never use render
order, camera coordinates, time, turn count or unseeded Math.random(). Moving the
camera, refreshing, resizing and replaying must not repaint the room.

Suggested deterministic layers:

1. **Structure:** neighbor masks for joined wall caps, front faces, corners and
   door surrounds. Known floor adjacency can select an inward-facing edge.
2. **Material regions:** broad, coherent fields or stable coordinate districts,
   softly varied through a small palette. Change large-scale material much less
   frequently than individual chips.
3. **Masonry and paving:** staggered courses; 2×1 slab motifs; occasional repaired
   blocks; corners selected through matching seam rules (Wang-style edge labels
   or equivalent). Clip motifs to the actual supplied terrain.
4. **Weathering:** clustered moss/damp at known wall contacts, crevice shadows,
   chipped slab edges. Sparse noise with spatial correlation, never confetti.
5. **Focal details:** varied door lintels, stair surrounds and fountain masonry
   attached to _actual known features_. Larger details belong where structure
   supports them, not in the middle of a walking lane.
6. **Microdetail:** one or two controlled flecks per selected tile. Preserve quiet
   space around creatures, objects, doors, stairs and selection indicators.

For complete offline layouts, room/corridor components can support an additional
structural analysis: room bounds, aspect ratio, entrances, broad material theme,
and balanced accent placement. The live game must not depend on a room's hidden
extent. Connected-component anchors can change as exploration reveals cells;
therefore live stable colors and object-like details cannot be keyed to a mutable
incomplete component. Coordinate-stable fields are the safe default.

## Decoration is not game knowledge

The renderer receives only the public observation (or an explicitly supplied
offline ASCII layout). No private engine lookup, hidden cells, monster identity
inference, inventory-letter lookup or cached old occupants.

Remembered terrain is remembered terrain, not proof of current line of sight.
Render only the occupants and objects included in the current frame. A symbol
can identify a class without identifying a species: use category illustrations,
with the exact symbol retained in tile inspection, the text map and a symbol toggle.
Never paint an invented chest, trap, collectible, creature or usable torch into
the live dungeon. Cosmetic chips, masonry, seams and moss do not become entities.
The welcome illustration can have props because it is clearly separate from a
game observation. Unknown terrain stays dark and contains no seeded hints.
An already observed actor, wall or door sprite may rise above its anchor into that
backdrop; its silhouette describes only that known feature, never hidden terrain.

The seed changes surface treatment only. It never changes terrain, doors, room
connectivity, visibility, movement, encounters, item identity or engine results.
No decorative pathfinding or creature AI runs alongside NetHack's rules.

### 3D masonry sprites

The user chose the 3D wall-sprite direction for NEO-2. Use the original stonework
palette and existing character art. `src/structure-sprites.ts` is the editable
geometry and rasterizer: volumetric walls, jambs, lintels and wooden leaves are
baked together with per-pixel depth, stone courses and plank/iron textures.

Ground anchors stay 16×16. Wall thickness is 10 units; full wall height is 20,
south foreground height is 6, retained east-wall height is 14, and door frames reach 24. The fixed projection is
`screenX = x - 0.375*z`, `screenY = y - 0.75*z`. Sprites occupy at most 25×34
pixels with an anchor offset of (9,18). Display at integer scales with smoothing
disabled. This is 3D geometry rendered to cached sprites, without a WebGL camera
or another game simulation. The cache holds at most 256 sprites.

Neighbor masks form continuous wall volumes and expose risers between different
heights. Supplied surface cells north of a wall choose a low south edge;
surface cells west of a wall choose a taller retained east edge
when the opposite side has no supplied surface. When there is no direct surface contact, northwest, northeast and southwest
diagonal surfaces lower an outer corner. Direct rear-facing contact takes priority
over diagonal hints, preserving full north/west runs; southeast remains a rear corner. This uses public
observation only and may update as exploration reveals terrain.
Door frames match the wall thickness and rotate as one mesh into the side-wall
orientation. Closed leaves sit at the visible wall face; open leaves fold against
the jamb. Bare doorways retain the frame. Apertures do not invent a floor or an
unseen destination. Door frame axes come from the shared library's public terrain
orientation (horizontal/vertical), including remembered doors. They describe the
frame, not the leaf or travel direction; neighboring cells do not choose the axis.

Draw ground, then wall sprites, then door fixtures, then actors. Known raised
silhouettes can overlap the dark backdrop; unknown ground stays unpainted. Fog,
viewport culling and feedback placement account for the full sprite bounds.
Workshop and live rendering share the same meshes. `masonry-3d-2` retains the
stonework-2 surface seeds so existing paving and wear do not reshuffle.

### Passage edges and actor motion

Corridors use connected 16px worn treads, distinct from room slabs. Stone shoulders
frame the outside edges of the perceived passage with a raised cap and recessed
face. These shoulders stay within known cells. A known adjacent surface opens the
whole edge; every unexplored edge gets a dark central notch, not a solid closure,
including the sides of runs and junctions. Continuous trim requires a known wall.
Side shoulders follow the known run, with corner openings for diagonal links.
These are cutaway trim, not collision facts. The notch marks uncertainty, not a
promise of a traversable route. No exterior
wall cells, exits or hidden floor are fabricated. Corners and junctions follow the
currently supplied neighbors and update as exploration reveals more.

The LimeZu characters use six authored frames for each of
four idle and four walk clips, on a 16×32 canvas,
with feet anchored at the bottom center of the player's actual tile. Walking plays
once after an observed adjacent displacement; blocked actions do not animate a
step. Facing persists through idle and inspections. Long displacements and level
changes do not invent a traversed path. Idle runs at six fps, walking at ten;
reduced motion freezes a directional idle frame and hidden tabs stop animation.

Movement input accepts taps and sustained holds on keys or direction buttons.
The first step runs immediately, then a 240 ms hold threshold leads into a
100 ms cadence, always waiting for the previous engine result. Keep only one
additional deliberate tap while busy; never accumulate timed repeats. Release
ends the hold. Stop on blocked/interrupted moves, damage, nearby visible creatures,
standing decisions, uncertainty, menus, blur or a hidden tab. Occupations and
other actions remain explicit one-shot inputs. Repeated successful steps share
one animation phase so the walk cycle does not restart at every tile.

Dog, cat and bat class illustrations use the installed original creature templates.
Other creature and loot categories use original outlined pixel grids in
`src/symbol-art.ts`. Food art includes the `%` class of food/remains; it does not
claim edibility or identify a corpse. No art choice supplies an operation target.

Rock-class objects use a broad, raised boulder silhouette in the world, with a
light crown, dark side face and contact shadow. The sprite extends beyond its
16px anchor tile. Ground objects render after terrain; mobile actors render afterward in foot
order, so a rock covers dungeon surfaces while characters remain in front. Inventory icons stay small.

## Standalone renderer workshop

Build a small Bun CLI alongside this example. Input: a UTF-8 NetHack-style ASCII
layout and an explicit seed. Output: a PNG at a chosen integer scale, plus a JSON
receipt recording input identity, seed, renderer version, geometry and output.
Include at least a room/corridor layout and a varied rooms-and-water layout.

Support common symbols with a documented, explicit legend: stone/unknown spaces,
walls `-|#` (with an unambiguous corridor convention), room floor `.`, corridors,
doors `+`/`/`, stairs `<`/`>`, water `~`, fountain `{`, altar `_`, player `@`.
Unknown symbols must be rejected or clearly reported, never guessed silently.
The CLI is an art tool; its input is not an engine migration fixture.

Generate a comparison sheet across several seeds and layouts to expose bad joins,
repetition, implausible trims and unstable variation. The UI and CLI must share
the same terrain renderer. Avoid a beautiful offline-only renderer that cannot
handle a partially explored live map.

## The play experience

- Immediate feedback belongs on the map: small parchment action bubbles near
  confirmed event locations, with general narration by the traveler. Door text
  anchors to an unambiguous publicly observed door transition. A silent completed
  search says “You search nearby.”; this confirms the action, not a discovery.
  Bubbles last about three seconds, never cover decisions, and do not replace the
  journal. Repeated renders, receipt recovery and resume must not replay them.
- Remembered terrain stays readable in cool gray, about one third dimmer; unknown
  ground remains empty behind observed raised sprites. Sight comes from the engine's optional `cell.visible`,
  never a client sight radius. Fade sight changes over 240 ms, and glide the camera
  over 110 ms after a confirmed step, rounding drawing positions to native pixels.
  Neither animation queues input or delays the next turn. Reduced motion settles
  immediately. Use View Transitions for panel changes, not per-turn map snapshots.
- Welcome: one clear beginning, a name, thirteen valid starting paths, an optional
  seed, and an honest statement about browser-local saves.
- Play: map first, readable health/status, tactile direction controls, a backpack,
  field notes and an obvious path to more actions. One keypress sends one action.
- Decisions: item IDs and choice IDs from the API; explicit direction/confirmation;
  cancellation only when supported. Never select by label, slot, or menu position.
- Uncertainty: freeze new input and offer a deliberate check of the same request.
  Do not hide storage failures behind cheerful save messages.
- Mobile: reachable 44px controls, no horizontal page overflow, a useful camera,
  full keyboard alternative and a readable text map. Support reduced motion.
- Optional animation must be presentation-only, slow and pausable. No movement
  loops that imply the game advanced while it did not.

## Assets

Keep the 29 runtime PNGs listed in `art/recipe.json`: thirteen character
portrait/sheet pairs and three animal portraits. Keep the selected asset/layer
identifiers and export parameters in the recipes and retain
[art attribution](art/ATTRIBUTION.md). Full vendor sheets and local art tools
are not project source.

Dungeon rendering code and layout recipes stay editable beside the example.

## Acceptance checks

Inspect native and 2× renderings; desktop and 390px browser screenshots; corners,
T-junctions, doors on each side, isolated pillars, narrow corridors and irregular
rooms. Verify seeded repeatability, meaningful variety across seeds and no invented
surfaces on unknown cells. Check raised observed sprites against their declared
bounds, including anchors just outside the viewport. Verify camera/resize stability, real engine turns, every supported
decision kind, serialized held movement and one-shot occupations, saved warnings across reload, failed ownership,
and failed/corrupt-storage states. A screenshot or compilation alone does not prove
playability. The workshop and real browser tests are complementary evidence.

## Interaction feedback and layer order

The world uses six explicit passes, from back to front:

1. Background: a restrained charcoal mineral texture, with no hints of unexplored
   rooms, routes or objects.
2. Walls and floors: connected raised stonework and walkable surface art.
3. Decals: surface wear and cosmetic ornament, reserved for later elaboration.
4. Sprites: doors, creatures, player and foreground objects, sorted by foot position
   above the dungeon surfaces. A creature never becomes a floor tile.
5. Modifiers: small comic question marks on category illustrations where the public
   API does not supply an exact identity; lock badges only on disclosed locks.
   Badges communicate knowledge, never hidden species or private door state.
6. Staleness: final grayscale/dimming over remembered surfaces, sprites and badges.
   Remembering a lock does not make it newly verified when the door comes into view.

Feedback should be brief, local and expressive:

- Swapping places with a pet needs no floating action message. Keep the engine's
  narration available in the journal.
- Successful door opening should get a tiny playful sound such as “kreeek…” or
  “womp”, anchored on the tile above the actual door. Keep the direction of travel
  clear, including when walking right. Failure and warnings still need clear text.
- Ground items belong in a right-side “On the ground” list with explicit loot
  actions, rather than repeated action bubbles. Populate it automatically from
  current public underfoot perception, which costs no input or turn; never send an
  inspection command merely to populate it. If perception is unavailable, say so.
  Use opaque item IDs and the displayed revision for pickup. Never auto-loot.
- Combat deserves a brief impact effect and possibly a very small screen shake,
  driven by confirmed public outcomes rather than invented hit/damage claims.
  Keep input responsive and the grid stable; disable shake and flashes for reduced
  motion. Do not equate a blocked movement request with a successful strike.

These refinements are implemented with current public perception and confirmed
results; the journal preserves the original engine narration.

## Fullscreen world and walk-in welcome

Keep a discreet, small-font `@tobi` link to `https://x.com/tobi` at the welcome
screen's bottom-right corner. Use readable muted text, a keyboard focus indicator
and a generous invisible touch target. Respect safe areas and keep it clear of
intro controls on narrow/short screens. Open a separate tab so the courtyard stays
in place; hide this secondary credit during gameplay to leave the HUD unobstructed.

The world fills the viewport. Remove the website shell, marketing cards, permanent
sidebars and duplicate narration. A small HUD floats above the map: health and
conditions at upper left, depth/turn and map tools at upper right, essential actions
at the bottom. Backpack, surroundings and journal open in a dismissible field-notes
drawer. Saves, help, text map and attribution remain reachable without occupying
permanent world space. Touch controls have generous targets; short screens and safe
areas must work without page scrolling. Browser fullscreen is an optional control;
the default already fills the available viewport.

The welcome is a separate, playable courtyard, with a deep torchlit entrance hall,
raised masonry, side alcoves, weathered paving and planted edges. Compose it around
a fixed native-pixel scene, centered at an integer scale. A traveler begins on the
approach, facing the entrance. Overlay four accessible arrow buttons and a brief
“Walk into the light” instruction. Keyboard arrows and held touch buttons move the
traveler with verified four-direction idle/walk art. Decorative collision belongs
only to this intro. Crossing the hall threshold opens character creation exactly
once; no engine session or turn is created until the player submits that form.
Crossing it first plays a 960 ms authored portal sequence: hard pixel bands wake
inside the arch, threshold runes answer from the center, the traveler is pulled
forward on their fixed sprite pivot and dissolves into deterministic two-pixel
light fragments before a stepped flare closes the scene. Input is locked for the
sequence, and character creation waits for its completion. This is presentation
only and reveals no game terrain. Reduced motion uses a short 120 ms two-frame
transition; hiding the page cancels entry and returns the traveler to the approach.
An accessible Begin button walks the approach automatically. Cancel returns the
traveler outside the threshold. Stop movement on blur, menus, visibility loss and
release. Reduced motion removes interpolation without changing input or entry.

Load public client libraries and warm the current WASM package in the background
while the player explores the title courtyard. Intro art and movement must not wait
for engine downloads. Warmup downloads files only: no engine, save-store lock or
session until starting/resuming an adventure or explicitly invoking a WebMCP tool.
Entering early waits for preparation with input reserved once, never queues duplicate
starts. Warmup and workers use the current package under `/runtime/wasm/` with cache
revalidation. Replace old builds and discard incompatible development saves;
there are no package archives or migration paths. Idle title tabs do not compete
for save ownership. Active engines still require the exclusive store lock, and a tab
refreshes adventure metadata after acquiring it so waiting title tabs cannot overwrite
another tab's saved progress. Failed speculative downloads are retried by the verified
runtime loader on entry; they must not freeze the courtyard.

## Browser agent access

Expose every existing MCP tool through native `document.modelContext` WebMCP (or early `navigator.modelContext` builds) when
available, using the same names, descriptions and JSON schemas as stdio MCP. Share
tool definitions so future catalog additions cannot drift. All calls retain supplied
request IDs, expected revisions, targets and decision answers, and run through the
public persistent WASM transport. Synchronize the visible game after agent actions;
serialize access with human input, retain uncertain requests, and retain current-runtime integrity checks. Never auto-answer warnings or repeat uncertain input with a new ID.
Unsupported browsers keep the human game fully functional; do not claim a JavaScript
shim is native WebMCP. Document capability detection and test the browser registration
contract plus actual engine calls.

### Creature recognition and local interaction

Use the engine's optional `occupant.appearance` to name the displayed creature and
choose species art. A visible newt is recognizable by looking; fighting is not an
identification requirement. This is the apparent form, never the hidden identity
of a disguised creature. Do not parse combat prose into identity. Hallucinated observations may omit the field; show a category and
explain the question mark in inspection rather than inventing an identify action.

Inspection leads with the clicked occupant, a sprite portrait and an Ally/Creature
label. Terrain titles apply to empty tiles. Moving toward an ally may swap places;
moving toward another creature may attack. Make this clear on the action buttons.
Keep risky actions secondary and provide a compact close control. No auto-action on
inspection or focus. All attempts use the API's action offer and observed revision.

Within the sprite pass, draw ground loot and fixtures first, then all mobile actors
in foot order. Never suppress a ground object because its cell has an occupant.
Raised silhouettes extend above their anchor tile instead of resembling floor decals.
When a unique public creature description shifts to an adjacent cell between frames,
move its destination sprite across the native pixel grid over 140 ms with a one-pixel
hop and sort it by its interpolated feet. Duplicate-looking creatures, arrivals,
departures and longer displacements settle at the newly observed position because the
protocol exposes no stable monster ID. Page hiding and reduced motion settle at once.
The current early-creature set has original editable pixel grids for newts, jackals,
lichen, goblins, kobolds, sewer rats and giant rats. Cat/dog/bat companions retain the
selected original template assets. Artwork is decorative and cannot identify a
creature when its engine description is absent.

The right-hand ground list reads current `here` perception for free and offers
explicit pickup by opaque item ID and revision. Routine pet-swap and ground-list
narration stays in the journal. Confirmed door opening says “kreeek…” above the door.
Confirmed strike narration gets a brief local impact; actual player health loss can
add a 160 ms, two-pixel shake. Never invent hit targets or damage amounts. Reduced
motion disables both effects. Search feedback and warnings remain visible.

### Direction targeting and quiet journal

Direction decisions use accessible arrows surrounding the player's map anchor,
with the center left clear. Arrow/vi keys answer once; Escape cancels only when
supported by the actual decision. Above, below and permitted self targets remain
explicit. Other decisions, especially confirmations, retain their modal controls.
A confirmed kick that consumes time gets the short impact/shake, including a miss;
it does not claim damage. Reduced motion suppresses this feedback.
When field notes are closed, the last three journal messages sit faintly at bottom
right on desktop. On mobile, place the preview beneath the top HUD, clear of the
player, stairs and bottom actions. Show it expanded by default; three single-line
entries truncate visually, while the full journal retains the original text. A
small chevron collapses/expands the preview, and a separate small arrow opens the
full journal. Both have 44px touch targets around compact 24px visible controls.
Keep the user’s collapsed choice through subsequent actions. Direction shortcuts
must not answer a standing choice while a modal, menu, drawer or editable control
has focus. Returning to the welcome screen from any decision releases the runtime
store owner without answering that decision. A runtime that finishes opening after
its client is removed must be closed, not adopted or used to create a world.

Consecutive identical journal messages share one entry with an accessible ×N repeat
count and their first/last turns. The preview shows the latest three groups with the
same counts as the full journal. New occurrences count; rerendering a receipt does not.

When the current public neighborhood offers an attemptable climb at the player's
cell, show a large Go upstairs/Go downstairs button centered at 70% viewport height.
It uses that offer and revision and disappears while input is busy, uncertain, ended
or awaiting a decision. Drawers and menus hide it to keep their controls clear.

## Class roster and scale

Character creation exposes all thirteen engine roles as fixed valid identity
presets in `src/characters.ts`. The catalog selects creation and HUD portraits
and live animation sheets. All thirteen use the established 16×32 LimeZu scale
over the 16×16 ground grid, with bottom-center (8,32) anchors.

Valkyrie restores premade character 03 and Wizard premade character 02. Ranger
restores its original layered traveler preset and supplies the welcome traveler.
The other ten class selections stay unchanged. The larger generated three-hero
pilot was rejected for scale; do not restore it or enlarge these defaults.

Each sheet is 384×64: right/up/left/down groups, six frames per direction, idle
above walking. Preserve native pixels, fixed pivots, facing and reduced motion.
Appearance is class illustration, not an assertion about equipped items.

## Early-monster scale

The user flagged oversized early monsters. Creature pixel grids now render at
one native pixel per grid entry; map zoom is the only world enlargement. Remove
neither native size differences nor the full-tile interaction target to improve
readability. Never restore the old unconditional 2× creature/category transform.

Newt and lichen silhouettes are six pixels tall, sewer rats five. Jackal, goblin,
kobold and giant-rat art uses native 12×12 grids, substantially smaller than the
32px-tall hero canvas. Giant rats stay visibly larger than sewer rats. All align
to the tile's lower center with a small contact shadow. Tiny creatures need not
protrude above their ground cell to be recognizable. Existing 16px companion
assets retain their native size. Unsupported apparent species use compact class
illustrations; neither glyph nor color supplies an exact species or physical size.

Inspection portraits magnify the early-creature drawing separately, so making a
newt small in the world does not make its inspection inaccessible. The sprite
selection still uses only publicly supplied appearance; unknown-species badges,
actor/loot ordering, text inspection and engine interaction rules remain intact.

The browser early-creature study compares the painted footprint to an empty
observation, enforces small bounds and the sewer/giant-rat size distinction, and
renders the group beside the default hero. Its screenshot is in ignored
`test-results/early-creatures.png`. Real-game and corridor-rendering regression
checks also cover this change.

## Additional common encounters

`src/encounter-art.ts` adds original editable native-pixel silhouettes for grid
bugs, giant ants, killer bees, cave spiders, geckos, garter snakes, foxes, coyotes,
floating eyes, gas spores, acid blobs and brown mold. The existing original
creature-grid renderer consumes them directly; there are no new vendor assets or
image-generation dependencies. Shapes, not color alone, distinguish each entry.

Grids range from 8–14 pixels wide and 6–10 pixels tall. The bee, eye and spore have
small static hover offsets, retaining their ground contact shadow and tile
anchor. Hover offset is illustration only, not a flight or collision rule.
No extra world scaling is applied. Portrait magnification remains separate.
Art selection requires the engine's apparent species; undisclosed or unpictured
creatures retain category art and normal knowledge badges. Static images do not
imply a turn, attack or movement.

The browser encounter-art test renders all twelve beside the hero using the live
map renderer, checks distinct art against same-category fallbacks, bounds painted
footprints, and checks unknown-appearance feedback. Its labeled comparison is
saved to ignored `test-results/encounter-art.png`.

### Loading into an adventure

After character creation or resume, cover engine preparation with a full-viewport
charcoal scene: repeated hard-pixel stone arches, an advancing tread, two amber
torches and the selected existing traveler portrait. This is a loading illustration,
not game movement or a progress estimate. Keep input blocked until the real result;
finish immediately on readiness and expose errors instead of leaving the cover up.
Reduced motion shows static nested arches. The welcome offers a prominent Continue
previous run button with name and turn when an unfinished save exists; a resumed
run moves to the front of the existing save list.

### Save-store ownership

Idle title screens release the WASM transport after WebMCP discovery, failed
starts and agent session close. Closing preserves pending decisions for resume.
A second active tab stays excluded and explains how to release the first tab
without deleting browser data; the client never steals its lock or retries game
input automatically.

### Map mode and focus feedback

Use the default illustrated map, including the dog sprite. The map-mode button
labels the current mode Art or Symbols, with a tooltip describing the switch.
Letter glyphs belong only to the explicitly selected Symbols mode.
Focus uses underlines and color changes on controls, without rectangular outlines
around the map, buttons or character cards. Preserve keyboard operation.

## Welcome page paths

The title is also the library’s frontpage. Keep the playable courtyard and its
walk-in entrance. Beside it on desktop, show three cards: Play the classic,
Play with WebMCP (link the agent-browser walkthrough), and build with the library.
Explain the separation of NetHack’s brain from its UX through the JSON protocol;
mention new interfaces, reinforcement learning environments and model evaluations.
Include a prominent GitHub link, NetHack history and sprite attribution. Show the
existing background package download status without constructing a game worker or
claiming offline/service-worker support. On narrow screens, stack the cards below
the courtyard with a visible jump link. Hide this content during gameplay.

The welcome page includes a syntax-highlighted, selectable TypeScript example
using `import Nethack from 'neonethack'` and `new Nethack()`. The hamburger menu
always includes GitHub, including during play. Active runs replace the page URL
with their session ID and private vault key; opening the bookmark resumes through
C. Show pending/acknowledged/failed cloud saving honestly. Remote uploads must not
block turns; local pre-input durability and uncertain-request guarantees remain.

Creation uses a bounded dialog with a single scrolling field region and a fixed
submit footer, including short landscape screens. WASD joins arrows and vi keys
for movement; F searches. Direction prompts and tile inspection also accept WASD.

A faint 15×9 classic-symbol neighborhood sits above the direction pad, centered
on the current player. It uses bundled JetBrains Mono (SIL OFL in public/fonts),
current public occupants and remembered terrain only. Unknown cells stay blank;
the decorative view consumes no engine input and does not intercept clicks.
Keep downstairs out of the permanent action dock: its contextual stair offer,
More actions and > shortcut remain. The hamburger offers Abandon run through
public game.quit, preserving the engine's explicit confirmation and terminal journal.

Disable item actions only when the current revision's C action offer says
knownBlocked. More actions includes a short reason below unavailable choices.
Never duplicate inventory eligibility rules in the client or probe by spending
input. Drink remains available on a perceived fountain/sink underfoot and asks
for the engine's confirmation; lack of potions alone does not block that use.

Keep the welcome arrow pad and its instruction/actions at the left edge, clear
of the centered traveler. Use a narrow left column on phones, retaining 44px keys.

Social artwork reuses the authored torchlit doorway, Ranger and dog in the same
charcoal/sage/gold palette. Keep the name and neohack.dev readable at preview size.
Provide a 1200×630 Open Graph card, 1500×500 profile banner with avatar space, and
1920×1080 transparent stream overlay. `art/social/composition.html` is the editable
composition; `scripts/build-social.ts` renders static, integer-scale frames through
the shared welcome-art method. Website metadata uses absolute neohack.dev URLs.

Mouse wheel zooms the dungeon between 1× and 4× over a short eased camera
transition; reduced motion applies it immediately. Fractional CSS enlargement
keeps nearest-neighbor pixels while native camera coordinates snap to pixel units.
Middle mouse drag pans without engine input, uses pointer capture and releases on
pointer cancellation or window blur. Wheel events over HTML controls keep normal
scrolling; browser Ctrl/Command zoom remains available. Tile picking follows the
same current camera transform. Zoom buttons and Center remain keyboard alternatives.

The title doorway has steady warm, stepped light from the first frame. An accessible
button over the actual gate starts the existing traveler walk and portal sequence,
then opens character creation. Clicking the doorway does not create a run itself.

A perceived hobbit uses a distinct original 12×12 silhouette: curly brown hair,
a sage waistcoat, warm face and broad bare feet. Keep the same native-pixel scale
as other small humanoids; use it only for the engine-supplied "hobbit" appearance,
never infer species from the h glyph. The unknown humanoid fallback stays generic.

Cloud journal and adventure metadata uploads wait for five seconds of inactivity.
New actions reset the timer. Queued changes show a stable "Saved here" status;
"Saving online…" appears only during an actual upload, with duplicate status
notifications suppressed. Local durable input transactions stay immediate, and
explicit runtime close flushes pending cloud work without waiting for the debounce.

Engine map-browsing prompts use a nonmodal position panel with eight cursor
directions, Help (?), Done/Select and Cancel. WASD/arrows move the cursor; Enter
or period finishes, Escape cancels, and clicking a map square explicitly selects
it. The engine-provided cursor is outlined on the map. A scrollable messages
disclosure preserves the full engine help. Gameplay shortcuts stay suspended.

New runs select current runtime metadata and record the immutable package hash.
Resuming a bookmark loads its recorded package, independent of the current release.
Title warmup preloads content-addressed URLs without owning a store.

The Adventure ledger opens from the game menu in a separate tab. It ranks public
run summaries by ascension, peak observed experience level, then turns; dungeon
location is descriptive, not a cross-branch depth score. Clearly label browser
reports and missing older data. Error telemetry sends only a bounded category and
engine package, asynchronously and once per category/package/page visit. Never
send bookmarks, vault IDs, raw messages, stacks or journals to the public ledger.

### Approachable action choices

Backpack rows show candidate actions supplied by the shared C driver, bound to the
current item ID and revision. Eligibility does not promise safety. The everyday
dock offers Search, Pick up, Eat and Pray; doors, stairs and drinking from a fountain
or sink appear in context. Ascending from the top dungeon floor reads “Leave” and
still goes through the engine's confirmation. Other actions remain in More actions.
The character sheet shows current wielded/offhand equipment and a larger experience
level. Low health or severe hunger outlines the sheet orange-red, then red at
critical severity; condition text and the health meter retain the same information.
Hungry adventurers get a restrained Eat glow; critical trouble also highlights
Pray, whose first use explains possible help, punishment and unknown safety before
the engine's own confirmation. These cues never automate an action.

Standing on a recognizable chest, box or bag offers “Open container”, using the
shared driver's underfoot loot offer and revision. Unknown contents require an
explicit Look inside action because inspection costs time. Known contents go
straight to two lists: Inside container and Your backpack. Checkboxes stage whole
stacks in either direction; Take everything selects all contents without engine
input, Clear selection resets the draft, and Apply transfers submits both sides
once. Show selection counts and disable Apply until something is selected.
Use two columns on desktop, stacked on phones. C supplies the container phase
and each option's take/put side; the UI never classifies labels. Engine transfer
rules run take-first, preserving warnings and interruptions rather than promising
rollback. Cancel discards the draft; reload restores the standing decision and
clears unsubmitted checks. Contents use decision choice IDs, not floor IDs.
Do not guess a container from its name or automatically select loot, unlock, trap
warnings or a second occupation. Unknown contents stay hidden until inspected.

### Automatic pickup preferences

Creation offers an Automatic pickup disclosure summarized as Gold + arrows on
first use. Reuse its accessible checkbox editor from the game menu and backpack.
Show Gold, Food, Potions, Scrolls and Weapons first, with remaining classes under
More item types. All types selects categories without disabling exceptions.
Reset defaults returns to enabled, gold, arrows, leave corpses and leave known
cursed items. Turning the master switch off keeps filters. Leave rules take
priority; thrown, dropped and recovered objects use the same filters. Ground
movement only: never open a container or issue follow-up pickup commands in JS.

Checkboxes change a local draft. Save updates the live engine through the public
revision-guarded method and then remembers future defaults; Cancel changes
neither. Creation remembers after success. Use validated version 1 preferences
under `neonethack.pixel.automatic-pickup.v1`; missing or invalid data uses the
defaults above. Storage failures show a notice without blocking play. Browser
preferences belong to this origin, are not cloud/account settings, and never
replace a resumed run's journaled configuration. Mobile keeps 44px choices and
sticky Save/Cancel controls; the active settings always come from C observation.

## Seeded room ambience pass

The user requested cosmetic room history: cracks, vines, shallow damp patches,
carpet remnants, straw, broken metal, recessed bookshelves, chains and sconces.
These are original editable native-pixel grids in `src/ambience.ts`, matching the
existing masonry palette; no additional vendor pack or runtime PNG is introduced.
This expands the earlier restriction on invented props: these wall fixtures and
worn fragments are explicitly noninteractive set dressing, never collectible
weapons, readable books, usable torches, water terrain or operation targets.

`room-ambience-1` hashes the actual stored game seed plus public location ID (already
supplied by the map) into damp ruins, abandoned quarters, old archives or rusted
cells. Broad 12×9 coordinate districts occasionally vary the level's dominant
palette of decorations. Independent ground, wall and spacing hashes keep results
stable through redraws, camera movement and input iteration order. No hidden room
bounds, gameplay RNG, time or private engine facts are consulted.

Only disclosed room floor supports dressing. Fixtures require a full-height disclosed wall run adjoining supplied floor; corridors, actual features and unknown cells receive
none. Floor wear stays within known 16×16 floor footprints. Wall fixtures are projected
onto the actual south/east masonry face and stay inside its declared sprite bounds,
below live actors, loot, doors, knowledge badges and remembered-cell dimming.
Torches have a hard-pixel amber inset, not a visibility radius. Native pixels and reduced motion
remain unchanged. `masonry-3d-4` includes this pass in both workshop and live art;
existing stonework seeds stay fixed. Workshop receipts hash the ambience source too.

Effects direction: retain the existing confirmed impact and brief damage shake,
respecting reduced motion. Prefer restrained local sparks and sconce flicker over
full-screen filters that reduce map clarity. No new shader is enabled in this pass.

Sound shortlist (checked 2026-09-06): [Kenney RPG Audio](https://kenney.nl/assets/rpg-audio)
has 50 CC0 foley/footstep/weapon files; [Kenney Impact Sounds](https://kenney.nl/assets/impact-sounds)
has 130 CC0 impact/foley files. Start by auditioning RPG Audio for dry stone steps,
door movement and short attacks, adding Impact Sounds only for missing material
textures. The initial RPG Audio selection is integrated below. Playback must stay opt-in, quietly
mixed, started by a user gesture, stopped when hidden, and keyed to fresh confirmed
receipts so resume/recovery never repeats a strike. Ambient beds must not imply
unseen monsters or terrain. Keep selected clips and their license, not full archives.

### Ambience refinement and optional sound

Carpet fragments now have a muted central diamond and irregular torn border;
shelf spines use desaturated sage and ochre within the original stonework family.
Visible sconces vary one flame pixel and their small amber inset every 420 ms,
with coordinate-seeded phases. Only explicitly visible cells animate. Remembered
cells, reduced motion and workshop output use a static flame. The animation clock
changes neither prop placement nor ground art, and the existing hidden-tab frame
pause applies. No full-screen shader or visibility-changing glow is added.

The first sound pass now includes four unmodified CC0 Kenney RPG Audio selections
in `public/audio/`, with original license and provenance. The menu's Sound button
is off by default and explicitly unlocks/loads Web Audio; the choice lasts for the
current page. Steps use two subdued footfalls, observed door opening a short creak,
and confirmed player strikes a compact impact. `src/sound.ts` consumes public
snapshots only. Revision high-water marks suppress duplicate feedback, including
receipts first encountered while muted. No delayed sound queue, ambient creature
noises, inferred weapon types or hidden event locations are introduced. At most
three clips overlap; hiding the page or disabling sound stops them. Audio failure
leaves gameplay available and offers retry through the same button. Removing the
client closes its audio context. Reduced motion suppresses visual animation without
silencing explicitly enabled audio.

### Renderer depth audit

The wall cutaway selector now prioritizes cardinal contact before diagonal corner
hints. Southwest floor cannot lower a rear wall already established by south floor;
northeast floor cannot lower a west wall established by east floor. Isolated
foreground corners still lower, and disclosed door axes remain authoritative.

Floor decals render after ground and before all raised masonry. Wall dressing is
sampled in world coordinates on the vertical face during the existing depth-buffered
sprite bake, using the same oblique projection, cache and sprite bounds as the wall.
It is no longer drawn at a floor-cell origin after the walls. East-facing fixtures
use the side plane. Only full-height straight runs carry fixtures; cutaways and
jambs stay clear. This is painted/recessed wall dressing, not protruding furniture
meshes. Mobile actors deliberately stay above terrain for readability.

Workshop output adds one cell of side/bottom padding and two cells above, recorded
in its receipt, without changing layout coordinates. The ambience study now shows
complete rooms with all four walls and a doorway rather than a clipped rear strip.
Regression checks cover diagonal reveal beside established rear walls, projected
wall-decoration bounds, full/live pass agreement, camera crop and unknown ground.

### LimeZu archive composition study

[studies/archive/scene.json](studies/archive/scene.json) is the first corrected
Modern Interiors room study, composed with `resources/tools/pixel` over our real
masonry output. It reuses the project's Ranger and dog. The selected library
shelves, ladder, desks, chair and rug were visually inspected; grouping, shadows
and native proportions are recorded in [the study notes](studies/archive/README.md).
This is a study, not integrated live decoration or a final approved art target.
The rug/books are still brighter than the dungeon palette. Keep the clear center
and authored furniture silhouettes while refining atmosphere. All generated study
images remain in ignored test-results; no additional runtime sprites are selected.

### Furniture floor contact and shadow variants

The user flagged the archive shelves' wall gap and mismatched pale flooring under
shelves/desks. Inspection confirmed the selected normal variants contain opaque
pale shadow pixels, not a required matching floor tile. For dark masonry, the
archive study now uses LimeZu's authored `-black-shadow` furniture variants,
whose shadows are translucent. Shadowless variants are also available; inspect
alpha and in-scene contact before choosing. Do not assume the skill's default
normal shadow works on every surface or paint additional shadows over vendor ones.

Place shelving by its visible footprint, accounting for transparent frame padding,
so its rear edge meets the actual wall/floor junction. The study shelves and ladder
moved 14 native pixels toward the wall; free-standing desks retain their positions.
The corrected recipe and native/3× previews are documented in the archive study.

### Cosmetic dressing must not promise an interaction

The user explicitly rejected desks as noninteractive background decoration. Their
size, work surface and readable-book contents imply usable objects; scattering
unusable desks would be frustrating. The archive study's desks and associated
chair are removed. Do not use them in the seed-driven decoration pool. Apply this
same affordance check to new props: prefer incidental wear and edge dressing,
and keep significant furniture out unless its interaction is supported by the
actual public game API. A visually compatible asset alone is not enough.

The right-wall cutaway was reviewed and the user accepted retained height with local occlusion relief. With the current projection,
height shifts northwest, so east/south walls can obscure room contents; this does
not justify lowering every entire near wall to the same height. Evaluate retained
wall height and localized occlusion relief before changing the default. The implemented policy is recorded below.

### Retained right walls and local readability cutaways

`masonry-3d-5` keeps east/right walls at 14 world units (10.5 projected vertical
pixels), rather than six. Rear walls stay at 20; the south edge stays at six.
The northeast elbow retains the rear cap height; the southeast elbow has a short low return. Full and partial heights use
the same connected mesh and expose matching risers at height changes.

The live map supplies current public player/occupant/item anchors and explicitly
visible doorways to the terrain renderer. Only an east-wall segment whose projected
bounds overlap these protected sprite footprints drops to six. Immediately adjoining
segments use ten-unit shoulders. The rest of the run retains 14. No inferred room
membership, hidden targets or camera-relative radius is used. Remembered occupants,
objects and doors do not trigger new notches. Actors still render above terrain.

This is a conservative sprite-bounds test rather than per-pixel visibility testing.
Geometry updates at observation boundaries and returns to retained height when the
protected footprint leaves; it does not animate through fractional-height meshes.
Reduced motion gets the same readable geometry. Camera movement does not change it.
The workshop defaults to retained walls unless explicit readable anchors are supplied;
its archive study has the traveler in the center, away from the right wall.

Tests cover local extent, unaffected distant segments, center-player stability,
restoration and identical camera crops, alongside real browser movement/zoom.

### Right-wall end transitions

The user flagged the northeast corner's detached-looking height step and the east
raised section running too close to the south corner. In masonry-3d-6, a disclosed
northeast elbow with connected west/south walls retains the rear cap's height of
20. Its east run then steps to 14 below the corner, keeping the rear cap continuous.
The last east-wall cell before a disclosed low south elbow is also low (six);
the preceding cell is a ten-unit shoulder. This ends the raised run earlier and
leaves a short low return into the bottom wall. Unexplored neighbors cannot cause
these end transitions. Local actor/item readability notches still apply.

The user refined the top-right profile: keep the corner fully raised and continue
that height for approximately two tiles down the right side, then step to the
intermediate run before the earlier low bottom return. masonry-3d-7 implements
that two-cell full-height continuation using only disclosed connected wall cells.
Short runs still prioritize the low south return. Current readable sprites can
still trigger local relief in the extended east section; its overlap bounds use
its actual retained height. The rear corner itself remains continuous.

### Layout-specific asset direction

The user rejected the archive shelving as dissonant and supermarket-like. Shared
LimeZu provenance does not establish dungeon suitability. Removed the shelf/ladder
set from the study; no such raster furniture is approved for live use. Earlier
positive notes about silhouette/scale do not override this rejection.

[art/layout-types/](art/layout-types/README.md) now separates defaults, dungeon and
cave profiles. Each type overrides shared palettes and approved decoration lists;
missing fields inherit and explicit arrays replace. The renderer and workshop
consume these profiles, and --layout-type selects an explicit study variant.
Dungeon is the live default. Cave currently changes surfaces/dressing, retaining
existing masonry geometry; natural cave structures remain future art work. Unknown
profile names are errors. Keep future approved type-specific assets/recipes beside
their profile and do not silently promote a local selection into shared defaults.

The active renderer version is masonry-3d-8 after layout-profile resolution and
removal of shelf dressing from defaults. Workshop receipts include the selected
layout type and hash every profile file as well as the renderer source.

The shared Modern Interiors compose tool now produces a fresh .audit.json beside
each output: frame origins, visible alpha bounds, padding, shadow variant, opacity
counts and source/recipe hashes. Use it to check wall contact and shadow suitability;
a passing audit cannot establish world fit or supported interaction. The shared
skill guide now records these distinctions and the need for layout-specific sets.

### Original cave geometry — user-requested development

The palette-only cave was rejected as another dungeon variant. It is preserved
as `dungeon-damp`; `cave` now selects original rock geometry, not masonry.
The first tileset uses faceted bedrock caps, fractured faces, inward-jittered
exposed edges and continuous unpaved soil. Shared joins use world-coordinate
heights; existing projection, cutaways and known-cell boundaries remain intact.
LimeZu catalog searches for cave/rock yielded no named entries. This user-requested
original environment extension does not authorize another vendor pack.

Recipe and scope: [cave tileset](art/layout-types/cave/README.md). The organic
cavern fixture is explicitly authored offline; it does not alter the engine map.
Live selection remains dungeon until a public layout classification is available
or the client explicitly selects a style. Current renderer: terrain-3d-9.

### Live environment selection

The user requested activation and commit of the completed environment work.
The live map now hashes its existing game-seed/public-location key into dungeon,
dungeon-damp or cave. This is a cosmetic seeded art choice, not an inference of
engine branch or hidden terrain. Revisits select the same style, and camera,
turn and cell-order changes cannot select another. Ground, raised walls, dressing
and the separate door pass share the chosen profile. The threshold stays masonry.
The proposed flooded ruins, mines, crypts, fungal and infernal styles are not
implemented and are not selectable. Earlier notes that live play always defaults
to dungeon are superseded by this activation.

## Component, accounts and ascender workshop

`/component` is a read-only developer landing page. Reuse the existing stonework
and LimeZu art through a self-contained shadow-DOM `<neohack-world>` viewer;
never create a game on the showcase. Charcoal, sage and warm cream carry into
editorial pages with large serif headlines, selectable code and responsive columns.
The component defaults to no engine connection. An explicitly supplied transport
controls discovery and execution; replay playback displays public frames only.

`/login` uses discoverable, user-verified passkeys and unique case-insensitive
handles. Explain the browser's phone/QR option for cross-device use. Private run
history records observed branch locations, experience level and recorded frames;
label browser-reported data and partial recordings honestly. Frame recordings are
separate from the authoritative engine journals and never resume games.

`/bots` is the Ascender workshop: CodeMirror, multiple JS/TS files, random class
and random seed by default, named private projects, a read-only world and bounded output.
Bot execution belongs in a worker inside an opaque sandbox with network blocked.
Use the public Game API, sequential calls, a fixed 1,000-call/five-minute limit and Stop.
Temporary test engines never acquire an existing save. A worker-hosted TypeScript
language service supplies cross-file completion, hover documentation and advisory
type diagnostics from the built library declarations. No npm package support is claimed. Signed-in tests save replay
observations; offline or failed uploads must visibly stop recording.

The workshop is a compact IDE surface: a project/run toolbar, file explorer, editor
tabs, resizable editor/world split, output panel and cursor/status rail. Keep the
workspace within the desktop viewport; stack panes on phones. Class and seed can
be fixed explicitly, with the actual randomly chosen values shown for each run.
Ctrl/Command-S saves and Ctrl/Command-Enter runs. No editable API budget control.

Every site surface includes the shared `neohack-rail` top rail: navigation and an
account button opening the passkey dialog in place. Signed-in users see their
name, run-history link and sign-out. Authentication changes update the current
page without discarding workshop code. Account dialogs suspend held game input.
Keep the rail above, rather than covering, the game HUD. On insecure HTTP origins,
the workshop explains HTTPS/localhost requirements before loading any engine;
never skip cryptographic package integrity checks.

The starter uses the library Hero facade and generated direction/species enums,
with contextual entrypoint types via defineBot. No hand-written direction helper
file is needed. Entity handles are revision-bound; sensing only selects disclosed
visible creatures and Enemy requires a known hostile attitude. Inventory name
queries resolve in the engine, with ambiguity preserved.

The workshop now starts with Curious imp, a two-file event-driven bot. One
initialize callback registers read-only observation events and one awaited turn
listener coordinates actions. The editable strategy biases toward unknown areas,
flees disclosed enemies, eats eligible food, attempts newly observed equipment,
and seeks downward stairs. Eligibility and movement facts originate in C; policy
remains in the example. Never present a sighting event as a hidden spawn/death.

## Backpack action strip and shared structure depth

Backpack entries use a quiet divider and a single row of unboxed action icons,
not a second stack of text buttons. Preserve the perceived item label and status.
Every icon retains its full action/item accessible name, a short hover title and
44px touch target; item details retain text action buttons. The Automatic pickup
shortcut is a compact line above the list. Actions still come from the current
engine item offer, with the existing revision guard and explicit decisions.

`terrain-3d-10` retains per-pixel height from the original structure rasterizer
and composites walls, cave rock and doors into one shared depth layer. With
`screenX = x - .375*z` and `screenY = y - .75*z`, greater Z at a shared screen
pixel is nearer the viewer. Ground-anchor order breaks coplanar ties consistently.
A separate doors-on-top pass is no longer used in the live map. Standalone door
previews are still useful for sprite/anchor inspection, not for scene composition.
The viewport buffers and baked color/depth data are reused; native pixel alignment,
revealed-cell boundaries, cutaways and reduced-motion behavior remain in effect.

LimeZu actors and perceived objects use their ground/foot positions within one
foreground layer: a nearer boulder can cover a figure behind it, and a nearer
figure covers the boulder. Animation hops change drawing position, not depth.
Actors remain readable above terrain through the existing cutaway policy; these
flat character sheets do not acquire invented 3D body geometry. Selection and
status cues remain a distinct interface overlay. Independent ray/box checks cover
both door orientations, all three door states and four neighboring wall heights.

Named bot provenance: `defineBot` requires an executable name and accepts typed
`autoloot` rules at construction, applied before initialization through the shared
engine operation. Signed-in workshop tests save the captured original and compiled
files before allowing bot input. Account history distinguishes automated runs from
interactive sessions and offers private source viewing/download next to replay.
The saved project label is independent of the bot definition's name. Source is
browser-reported and immutable for that recording; anonymous tests are temporary.

Automatic pickup accepts editable Loot patterns and Ignore patterns, one literal substring per line. Matching uses perceived names without case sensitivity; ignore and leave rules take precedence. The same typed settings are available at bot construction and persist with sessions and recorded bot source.

## Journal scrolls

Keep complete heard-event batches from public receipts, including blank lines;
the rolling observation preview can omit the beginning of a passage. Multiline
batches appear as clearly labeled, clickable scrolls in recent notes and the full
journal. A modal reading surface preserves the exact text and paragraph breaks
above the game, with keyboard dismissal and an explicit return button. Opening
and closing it are free presentation actions, and held movement stops. Show the
first passage automatically after successful human character creation, never on
resume or repeated rendering. Notes remain scoped to the current visit, as the
journal explains. Grouping is presentation only: do not infer quest rules or
hidden narrative categories from wording.

## Naming a consumed potion

A text decision explicitly marked `consumedPotionNickname` lifts the witnessed
narration into the dialog: “You drank the potion”, the engine's effect text,
and “You aren’t sure what the potion did. Give it a nickname, or generate one.”
Retain the original appearance prompt and the journal copy. Explain that this
labels the potion type rather than identifies it. Prefill the editable nickname
with the witnessed effect text, folding whitespace for the single-line field.
Generate nickname fills an
editable suggestion only; Use nickname submits the standing decision, and Skip
nickname declines naming without implying that drinking can be undone. Cosmetic
name generation uses browser randomness, never the engine's random stream.
Other text decisions retain their ordinary wording.

## Script state and controls

The workshop renders author-provided buttons and checkboxes beneath a player-owned
script state field. Scripts start in run; null yields and disables all controls.
Yield ends a workshop test, keeping its component read-only. The SDK supports
host-driven resume for a future live-game attachment. Script notes show their
script author and engine turn, and signed-in users can read the private script
journal beside saved source/replay. These annotations never appear as engine facts.
Automatic pickup has an explicit Review before collecting toggle: the engine asks
for a selection before transfer, preserving its suggestions without auto-selecting.

## Item silhouettes follow perceived appearance

Backpack, ground list and item details share appearance-based icon selection from
`known.appearance`, supplied by the engine independently of decorated labels,
nicknames and magical identification. Shields, gloves, boots, helmets, cloaks,
maces and chests have distinct original 12px silhouettes in `src/item-art.ts`,
extending the existing original item grids. Modern Interiors catalog searches
found no named shield/chest assets; no vendor pack or runtime PNG was added.
Unsupported weapon/armor/tool appearances use their neutral class glyph rather
than an unrelated sword, shirt or pick. Missing appearance and hallucination
cannot select specific shapes. Known identity does not override the appearance.
The text remains authoritative; icons are decorative and never operation targets.

## Error pages

400, 404 and 500 pages use stone numerals, amber torches, the existing LimeZu
Valkyrie and original dog. The editable generator is `scripts/build-errors.mjs`
and styling is `art/errors/style.css`. Outputs are self-contained static HTML:
inline pixel SVG, embedded existing sprites, no JavaScript, external fonts or
runtime requests. Recovery is a normal link to the entrance; server failures
remind players to keep their bookmark and browser data without promising that
unsynced progress reached the server. Keep ordinary API errors structured JSON.
