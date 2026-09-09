<!-- Canonical product name: neohack (lowercase). NetHack denotes the upstream game. -->
# neohack: a place worth descending into

## Current UX and implementation boundaries

This file records current design decisions. Sections explicitly called targets,
proposals or studies are not claims of shipped behavior. Replace superseded
instructions when a decision changes; do not leave competing rules below.

- Human, accessible and agent views share the C protocol's perceived facts.
  Illustrations never identify hidden items, predict safety or weaken the game.
- The game is browser WASM; Vercel handles accounts, compressed input archives,
  the public ledger and observation recordings. Published runtime pins and
  production data survive deployments; disposable development fixtures do not
  justify deleting a player's progress.
- The HUD is compact: level at top right, health values together, equipped item
  icon on one line, and no normal hunger/burden text. The character sheet puts
  stats beside the portrait, gear around a paper doll beside an independently scrolling bag.
  Dragging selects an engine-provided equipment destination; actual outcomes and warnings
  belong to the engine. Text-map access belongs in Surroundings.
- Journal scrolls require an engine-marked passage with four non-empty source lines. Short notices stay inline.
- Workshop projects are JavaScript with TypeScript editor assistance; the same
  example sources run in the browser sandbox and the trusted local Node runner.
- Ground is drawn first; walls and doors share per-pixel structure depth. Actors
  and known raised objects share foreground foot ordering. Do not restore an
  unconditional doors-on-top pass.
- The live dungeon uses a retained scene: canvas bakes native-pixel art into
  bounded atlases and world-space terrain chunks; browser compositor transforms
  move the camera and sprite strips. There is no live-game animation-frame
  redraw loop. Observation changes invalidate affected art; pan, zoom, idle
  animation and elapsed turn count never regenerate static terrain.

For API guarantees use [PROTOCOL.md](../../lib/neonethack/docs/PROTOCOL.md);
for hosting use [the Vercel guide](../../hosting/vercel/README.md).

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

### Retained rendering and compositor motion

`src/retained-scene.ts` owns persistent scene nodes and browser animations;
`src/terrain-scene.ts` invalidates 8×8-cell terrain chunks from perceived
geometry, relevant cutaway anchors and visible torch state. Neighbor margins
preserve connected masonry and depth across chunk edges. `dungeon-art.ts`
remains the common rasterizer for live chunks and standalone art. Its bounded
earth atlas preserves the original deterministic pixels; four recent palettes
and seeds use at most 8 MiB of atlas pixels per document.

The camera transforms a world-space container. Hero directions and walk/idle
clips share one baked atlas; visible torch chunks have three baked frames.
Sprite-strip transforms, observed movement and visibility opacity use the Web
Animations API. The main thread updates stacking order during observed movement
so moving creatures and raised objects keep their foot ordering. It does not
redraw their pixels. Hit testing inverts the actual animated camera transform
and tests the retained sprite alpha at its current displayed position.

Remembered terrain uses a clipped grayscale/tint backdrop. Settled memory shares
one layer; only active sight transitions create temporary opacity layers, which
are merged after the fade. Unknown cells never acquire inferred visibility.
Death impressions still age only on engine turns, with opacity set by that age.
Reduced motion settles movement and displays static sprite frames; hidden pages
pause motion. Run/level changes and removal release retained scene state.

The authored title courtyard retains its separate portal animation; it is not a
live game observation. Keyboard and pointer access remain on the accessible
canvas surface, while visible gameplay is composed from its retained sibling.
Do not restore a duplicate viewport bitmap for canvas readback: art tests inspect
retained buffers, and browser screenshots/traces validate the composited result.

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

Draw ground, then a shared wall-and-door structure depth layer, then actors and
raised objects in foot order. Known raised
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

Disclosed dog, cat and bat appearances use the installed original creature templates.
Other creature and loot categories use original outlined pixel grids in
`src/symbol-art.ts`. Food art includes the `%` class of food/remains; it does not
claim edibility or identify a corpse. No art choice supplies an operation target.

Weapon map/inventory/HUD art uses original editable 16×16 pixel grids in
`src/equipment-pixels.ts`, with upper-left metal highlights, muted steel, wood
and brass. Twenty-four weapon shapes cover all 71 weapon definitions' perceived
appearances in the pinned `objects.h`; related weapons share shapes. The user
approved all thirty weapon/statue drawings on 2026-09-08. All six statue designs
now select from structured `known.depictedCreature`: generic, canine, feline,
bird, serpent and dragon. Unmapped/unknown subjects retain the generic statue.
The engine emits an observed statue's subject in item knowledge and uses the
rendered statue glyph for map knowledge, including remembered/apparent statues.
Weapon map shapes also come from rendered physical appearances. Hallucination
withholds these structured details. Never infer them from labels, glyph letters,
nicknames or hidden occupants. World, local, accessible text, inventory and HUD
use these same perceived facts; symbol mode keeps the original display marks.
Other map object classes retain their class art unless a current floor item
explicitly supplies an appearance. There is no extra image request or atlas-load
race: all views draw the same editable grids synchronously.
This expands the approved original item-art exception without changing the base
pack. The inspected LimeZu museum statues (0256–0267) are seated-figure variants,
not the animal variety requested here. The engine's original tile sources are
also present but are not the selected web art.

Run `bun scripts/render-equipment.ts` to export the exact runtime grids as a
transparent eight-column sprite sheet, frame manifest and native/4× preview
under `test-results/art/equipment/`. The exporter checks grid bounds/palette and
coverage against the pinned weapon definitions. Source grids are the editable
recipe; exported review/build artifacts stay out of source and `public/art/`.

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

The world follows these layer responsibilities; shared structure depth, rather
than an independent door pass, resolves overlapping masonry:

1. Background: a restrained charcoal mineral texture, with no hints of unexplored
   rooms, routes or objects.
2. Ground and surface decoration: walkable surface art and seeded wear.
3. Structures: connected walls and doors composited by shared per-pixel depth.
4. Foreground: creatures, player and raised objects, sorted by foot position
   above the structures. A creature never becomes a floor tile.
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
  Use opaque item IDs and the displayed revision for manual pickup. Automatic
  pickup is configured in the engine; the UI never emits follow-up pickup commands.
- Combat deserves a brief impact effect and possibly a very small screen shake,
  driven by confirmed public outcomes rather than invented hit/damage claims.
  Keep input responsive and the grid stable; disable shake and flashes for reduced
  motion. Do not equate a blocked movement request with a successful strike.

These refinements are implemented with current public perception and confirmed
results; the journal preserves the original engine narration.

## Fullscreen world and walk-in welcome

The site top bar contains the welcome tagline, runtime download status, GitHub,
account controls and game menu. Keep them out of the welcome card column. At
narrower widths, metadata and GitHub share a compact second header row; during
play, hide welcome metadata and keep navigation and the menu in one row. The
world fills the remaining height. Menu contents remain anchored to their button.

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
starts. New games select `/runtime/wasm/current.json`; resume selects the recorded
`/runtime/wasm/<buildId>/` package. Hosted verified packages are retained across
deployments. Incompatible local development fixtures are disposable, but no
published run is silently upgraded or migrated. Idle title tabs do not compete
for save ownership. New adventures have separate local stores; active engines
retain exclusive ownership of their own store. Run metadata uses separate keys,
so tabs cannot overwrite another adventure's progress. Failed speculative downloads are retried by the verified
runtime loader on entry; they must not freeze the courtyard.

## Browser agent access

Expose every existing MCP tool through native `document.modelContext` WebMCP (or early `navigator.modelContext` builds) when
available, using the same names, descriptions and JSON schemas as stdio MCP. Share
tool definitions so future catalog additions cannot drift. MCP/WebMCP expose the navigation agent vocabulary; the adapter owns operation
IDs, observed revisions and response reconstruction. Explicit short run tokens,
perceived targets and deliberate decision answers pass through the public
persistent WASM transport. Synchronize the visible game after agent actions;
serialize access with human input, retain uncertain requests, and retain current-runtime integrity checks. Never auto-answer warnings or repeat uncertain input with a new ID.
Unsupported browsers keep the human game fully functional; do not claim a JavaScript
shim is native WebMCP. Document capability detection and test the browser registration
contract plus actual engine calls.

### Creature recognition and local interaction

Use the engine's optional `occupant.appearance` to name the displayed creature and
choose species art. A visible newt is recognizable by looking; fighting is not an
identification requirement. This is the apparent form, never the hidden identity
of a disguised creature. Do not parse combat prose into identity. Hallucinated
observations may omit the field; show a neutral cloud with a question mark and
explain the question mark in inspection rather than inventing an identify action.

Inspection leads with the clicked occupant, a sprite portrait and an Ally/Creature
label. Terrain titles apply to empty tiles. Moving toward an ally may swap places;
moving toward another creature may attack. Make this clear on the action buttons.
Dock the inspection card at a stable viewport position; arrow/vi inspection changes
its contents without moving the panel. Keep title, book/close controls and shortcut
footer visible while the action body scrolls. Actions have numbered key badges,
arrow keys inspect, / opens lore, and Escape closes. Disabled actions never become
keyboard inputs. Keep risky actions secondary. No auto-action on
inspection or focus. All attempts use the API's action offer and observed revision.
While the card is open, outline its selected tile with one native pixel of sage.
Draw it above terrain and below every creature, hero and object sprite, including
neighboring sprites that extend over the tile. The outline follows keyboard
inspection and the map camera; closing the card or taking an action clears it.
This marks the inspected ground square, independently of an engine target cursor.

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
counted action's multiline event batch follows the same compact preview rule;
desktop previews allow two lines per ordinary batch, with repeat counts kept visible.
Only the full journal preserves its line breaks; engine-marked scrolls keep their
separate reading link and four-source-line classification. A
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
creatures use the same neutral cloud and question mark, independent of glyph and color. Static images do not
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
New adventures get independent stores and can be played concurrently in different
tabs, including offline. The shared adventure list has one metadata key per run;
each tab writes and publishes only the run it owns. Existing published saves keep
their original stores and runtime pins.

Opening the same bookmark requests a cooperative handoff through BroadcastChannel
and a Web Lock. The old tab stops held movement/navigation, finishes its accepted
input and receipt, then closes its engine before releasing ownership. It offers
Play here or Start a new adventure. Focus changes never take ownership back.
The new tab restores the actual journal and standing decision; it never forks the
run or repeats an uncertain input. An agent in the old tab must explicitly resume
before acting again. The worker's exclusive store lock remains the final guard.
If an old or suspended page cannot cooperate, entry times out without changing
its save; a different new adventure still has an independent store.

### Map mode and focus feedback

Use the default illustrated map, including the dog sprite. The map-mode button
labels the current mode Art or Symbols, with a tooltip describing the switch.
Letter glyphs belong only to the explicitly selected Symbols mode.
Focus uses underlines and color changes on controls, without rectangular outlines
around the map, buttons or character cards. Preserve keyboard operation.

## Welcome page paths

On desktop, align the welcome heading and GitHub link with the game menu, below
the account rail. Reserve space for the menu's 44px target. Only the content
beneath this heading scrolls, keeping navigation clear of the scrollbar. On
phones, retain the stacked welcome content and a single page scroll.

The title is also the library’s frontpage. Keep the playable courtyard and its
walk-in entrance. Beside it on desktop, show three cards: Play the classic,
Have your Agent play (link WebMCP and the agent-browser walkthrough), and build with the library.
Explain the separation of NetHack’s brain from its UX through the JSON protocol;
mention new interfaces, reinforcement learning environments and model evaluations.
Include a prominent GitHub link, NetHack history and sprite attribution. Show the
existing background package download status without constructing a game worker or
claiming offline/service-worker support. On narrow screens, stack the cards below
the courtyard with a visible jump link. Hide this content during gameplay.

A small “N games played” link at the bottom of the courtyard opens the Adventure ledger.
It uses the ledger's total recorded runs, not players or only completed lives.
Fetch the compact public count once in the background; its CDN cache may lag by
a few minutes. Missing, invalid or offline responses leave the link hidden, never
show an invented zero or a gameplay error, and never gate character creation.

The welcome page includes a syntax-highlighted, selectable TypeScript example
using `import Nethack from 'neonethack'` and `new Nethack()`. The hamburger menu
always includes GitHub, including during play. Active runs replace the page URL
with their session ID and private vault key; opening the bookmark resumes through
C. Show pending/acknowledged/failed cloud saving honestly. Remote uploads must not
block turns; local pre-input durability and uncertain-request guarantees remain.

Creation uses a bounded dialog with a single scrolling field region and a fixed
submit footer, including short landscape screens. Lowercase NetHack directions join arrows
for movement; s searches and comma picks up. Direction prompts and tile inspection
also accept h/j/k/l and y/u/b/n.

A faint 15×9 classic-symbol neighborhood sits above the direction pad, centered
on the current player. It uses bundled JetBrains Mono (SIL OFL in public/fonts),
current public occupants and remembered terrain only. Unknown cells stay blank;
the decorative view consumes no engine input and does not intercept clicks.
Keep downstairs out of the permanent action dock: its contextual stair offer,
More actions and > shortcut remain. The hamburger offers Abandon run through
public game.quit, preserving the engine's explicit confirmation and terminal journal.

Disable item actions only when the current revision's C action offer says
knownBlocked. More actions includes a short reason below unavailable choices.
More actions opens with `Ctrl+K` (`Cmd+K` on Mac), `#` or its visible button. Its Lit search component keeps
the input across the top, focused on opening; the matching list alone scrolls.
Match action labels and names by ordered fuzzy letters alongside exact classic shortcuts and
the shared command grammar (`20s`, `20.`, `mh`). Typing filters without executing;
arrows select and Enter/click explicitly tries a result. A bare count offers both
search and rest. Keep unavailable matches visible with reasons, and bind each
callback to the opening game/revision. Exact shortcuts and names rank first;
contiguous matches, word starts and shorter labels rank above scattered matches.
Underline matching letters; use no recency or gameplay-policy weighting.
Single item and single-choice engine questions drill down inside the same dialog,
with perceived item icons and a fresh focused search field. Scrolls/books come
first for Read, tools for Use and weapons for Wield; this is presentation order,
not a claim that other attempts are impossible or these are safe. Show every engine
option, including special choices; do not reconstruct eligibility from inventory
categories. Escape/Back explicitly cancels the exact question and returns to the
parent search/selection at the resulting revision; closing cancels and exits.
Cancellation is not a rewind and never promises zero elapsed turns. Noncancellable
questions cannot be backed out of. Targets, warnings, text and multi-selection
transfers keep their dedicated controls. Further input waits for settlement;
uncertain results retain the normal recovery UI. Old callbacks cannot answer a
different question or act on a newer revision. Root Escape closes and restores
focus. Ctrl/Cmd+K refocuses an open picker and does not hijack other forms or
standing decisions. Direct in-game classic prefixes retain their existing composer.
Chat is available by searching `chat` (or `#chat`) in More actions. It opens the
engine's “Talk to whom?” direction question; choose an adjacent character's
direction. Consultations, donations and other dialogue choices remain explicit
engine decisions. Opening/filtering the menu never initiates a conversation.
Share action definitions between the menu's visible key badges and map shortcuts.
Use compact 36px text buttons on desktop, 44px on phones/coarse pointers, and
consistent 6px/12px padding; icon targets retain their existing 44px geometry.
All scrollable surfaces use thin native scrollbars with a muted sage thumb and
a transparent track. `src/scrollbars.mjs` owns this default across page shells,
shadow-root components and self-contained error pages. The generated page
stylesheet is cached for offline play. Use the browser’s normal scrolling,
keyboard and touch behavior; forced-colors mode keeps native system sizing and
colors. New panels inherit this style without their own scrollbar rules.

Recurring controls should become small Lit components as they are improved,
following the examples in AGENTS.md; game state and decisions stay with the caller.
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

Input archive and adventure metadata uploads wait for five seconds of inactivity,
with a thirty-second maximum during ongoing play. New actions reset the idle timer. Queued changes show a stable "Saved here" status;
"Saving online…" appears only during an actual upload, with duplicate status
notifications suppressed. Local durable input transactions stay immediate, and
an explicit share or finish requests a flush. A network failure retains pending
inputs locally; it never delays the next game action.

Engine map-browsing prompts use a nonmodal position panel with eight cursor
directions, Help (?), Done/Select and Cancel. NetHack direction letters/arrows move the cursor; Enter
or period finishes, Escape cancels, and clicking a map square explicitly selects
it. The engine-provided cursor is outlined on the map. A scrollable messages
disclosure preserves the full engine help. Gameplay shortcuts stay suspended.

New runs select current runtime metadata and record the immutable package hash.
Resuming a bookmark loads its recorded package, independent of the current release.
Title warmup preloads content-addressed URLs without owning a store.

The Adventure ledger opens from the game menu in a separate tab. At the top,
plot the latest 200 updated public runs: turns on the horizontal axis and deepest
reported dungeon level on the vertical axis, with an option to show best hero
level instead. Color by actual character class (falling back to starting class),
with labelled class filters and an unknown-class color. Selecting a dot shows
the name, class, progress and an explicit Show replay button when available.
Coincident points offer a run chooser; keyboard arrows and a complete accessible
table provide alternatives to pointer selection. Plotting never downloads replays.

Show the top three hero-level and dungeon-depth records separately for Today
(since midnight UTC) and Last 7 days (today plus six prior UTC dates). These rank
each run's best reported progress among runs updated in the window, across the
whole ledger, not just the plotted 200 or all-time leaders. They are not claims
about when the high score was achieved. Unknown scores are omitted, not zero;
never parse a dungeon label to manufacture a numeric depth. The all-time list
continues to rank by ascension, peak experience level, then turns. Clearly label
browser reports and missing older data. Error telemetry sends only a bounded category and
engine package, asynchronously and once per category/package/page visit. Never
send bookmarks, vault IDs, raw messages, stacks or journals in diagnostic reports.
Reports go to structured Vercel logs; the public ledger API excludes diagnostics.

### Approachable action choices

Backpack rows show candidate actions supplied by the shared C driver, bound to the
current item ID and revision. Eligibility does not promise safety. The everyday
dock offers Search, Pick up, Eat and Pray; doors, stairs and drinking from a fountain
or sink appear in context. Ascending from the top dungeon floor reads “Leave” and
still goes through the engine's confirmation. Other actions remain in More actions.
The HUD shows current wielded/offhand equipment and experience level at top right.
Low health or severe hunger outlines the HUD orange-red, then red at
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
Use two independently scrolling item columns on desktop and phones. C supplies the container phase
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
or the client explicitly selects a style. Current renderer: terrain-3d-10.

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
controls discovery and execution. New replay playback reconstructs observations
in isolated pinned WASM from static input archives.

A dungeon chronicle is a one-page comic retelling of a public run that ended in
death after reaching dungeon level 3 and experience level 2. The death screen
offers **Tell the tale** once the recording is public. Every run's home is its
own page, `/replays/<id>`, which leads with the chronicle: an existing tale is
the first section above the player, and an eligible untold run is offered there
and streams in as it is written. The ledger never opens a run in place: every
Show replay is a link to that page, and rows with a written tale show a scroll
icon beside it that deep-links to the story (`?view=chronicle`). Older
`/dashboard?run=<id>[&view=chronicle]` addresses forward to the run's page.
The server replays the archive, asks the model once, and caches the story
publicly; opening a tale never regenerates it. While it is written, the page
shows the work honestly: replay progress in moves, then the title and paragraphs
appearing as the chronicler writes them, then the stored story with its lookups.
An open story is always the page's address (`/replays/<id>?view=chronicle`)
so the address bar is the share link. Present the story in serif reading type with
the hero's name as an eyebrow, even leading (inline lookups must not change
line height), comfortable paragraph spacing on phones, and label it plainly as
an AI retelling of the recorded journey, not the journal. Names the recording
actually mentioned (monsters, items, gods, roles) carry a quiet dotted underline
that never competes with the text; a tap opens the pinned encyclopedia entry in
a small popover anchored to that name (below it, or above when there is no
room), closed by its ×, Escape or a tap elsewhere. Words the model introduced
are never linked, and the lore is reference text, not a claim about what the
hero met. Ineligible runs show no tale controls; a failed generation reports a
readable reason and offers a plain retry.

`/login` uses discoverable, user-verified passkeys and unique case-insensitive
handles. Explain the browser's phone/QR option for cross-device use. Private run
history associates input archives, observed locations and experience level.
Label browser-reported data honestly. Replay links are unlisted and readable by
anyone who has them; account access is for discovery, source and script notes.

`/bots` is the Ascender workshop: CodeMirror, multiple JavaScript files, random class
and random seed by default, named private projects, a read-only world and bounded output.
Bot execution belongs in a worker inside an opaque sandbox with network blocked.
Use the public Game API, sequential calls, a fixed 1,000-call/five-minute limit and Stop.
Temporary test engines never acquire an existing save. A worker-hosted TypeScript
language service supplies cross-file completion, hover documentation and advisory
type diagnostics from the built library declarations. No npm package support is claimed.
Workshop and human runs use the same append-only input archives and background
upload schedule. Exact script source and notes are saved locally first and backed
up privately for signed-in authors; the input replay remains an unlisted link.

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

The workshop starts with a chooser: create a script, try Curious imp, Cartographer, Steady fighter or First steps,
or open an account script. Examples remain immutable; first Save creates a private
account copy and a `/bots?script=<id>` URL, while later saves update that copy.
Opening an example clears the saved identity. URLs require the owning account.
Workshop files are always JavaScript, with `main.js` as entrypoint and a Format
button using Prettier. Define the bot at the top, then use `bot.on()` with plain
payloads and live hero/game/log context. `start` configures controls; read-only
observation handlers and one awaited `turn` listener coordinate the script.
Curious imp keeps a short main.js policy with readable explore.js and care.js helpers.
Plan routes over the disclosed map, open doors, remember failed edges, search a
bounded number of times and try identified rations. Retreat from nearby enemies;
stop when no retreat remains or a decision requires another strategy. Cartographer
stays on one level; Steady fighter adds an explicit combat policy. First steps
remains a one-action teaching example. Eligibility and movement facts originate in
C; policy remains in the examples. Never present a sighting event as a hidden spawn/death.

One source catalog supplies the chooser and the Node test runner in examples/workshop.
Each account copy includes all of its helpers. Keep the chooser's mark/copy/action
structure for every card. The Node runner executes those exact JavaScript files
against a fresh native engine with call/time limits and diagnostic summaries;
it is trusted local Node code, separate from the browser sandbox.

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
flat character sheets do not acquire invented 3D body geometry. The inspection
outline is below foreground sprites; status cues remain above them. Independent ray/box checks cover
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
the rolling observation preview can omit the beginning of a passage. Engine-marked text-window passages with at least four non-empty source lines
appear as clearly labeled, clickable scrolls in recent notes and the full
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
maces and rigid containers have distinct original native-pixel silhouettes in `src/item-art.ts`,
extending the existing original item grids. Modern Interiors catalog searches
found no named shield/chest assets; no vendor pack or runtime PNG was added.
Unsupported weapon/armor/tool appearances use their neutral class glyph rather
than an unrelated sword, shirt or pick. Missing appearance and hallucination
cannot select specific shapes. Known identity does not override the appearance.
The text remains authoritative. Item icons decorate labeled controls; equipment
drop targets use engine-provided opaque references and destination offers.

## Error pages

400, 404 and 500 pages use stone numerals, amber torches, the existing LimeZu
Valkyrie and original dog. The editable generator is `scripts/build-errors.mjs`
and styling is `art/errors/style.css`. Outputs are self-contained static HTML:
inline pixel SVG, embedded existing sprites, no JavaScript, external fonts or
runtime requests. Recovery is a normal link to the entrance; server failures
remind players to keep their bookmark and browser data without promising that
unsynced progress reached the server. Keep ordinary API errors structured JSON.

## Embeddable public replays

`neohack-world` accepts a public replay `src` (`/replays/{run-id}`), a static manifest, or paginated
observation JSON, `autoplay`, `speed`, `sound`, `controls` and `loop`. Default speed
is 4× (16 recorded frames per second); controls overlay the bottom with Play/Pause,
frame seeking, speed and gesture-enabled optional sound. HTML controls retain
44px targets and keyboard focus. Removal cancels loading and pauses playback.
The game hamburger remains anchored beneath its 44px button with a bounded menu.
Its Copy run embed action supplies a public source without the private vault URL.

New runs append client-to-engine requests locally. No observation copy is written
on each turn. Strict local reservations and completion evidence protect recovery;
compressed uploads happen asynchronously every five seconds idle / thirty seconds
active. Level changes can add real engine checkpoints with a scene preview.
Sharing uses the direct static manifest URL, with no upload capability. Anyone
with the link can watch; script source, notes and account identity stay separate.
The death screen can request a flush, but offline failure retains the local log.
Existing published frame archives remain readable and are labelled when partial.

## Hero tombstone

A confirmed `ended: true` / `end.kind: "death"` replaces the hero with the existing
original gravestone sprite at the current public `observation.you` position. Both
the live map and replay viewer pass these terminal facts to the shared renderer.
It is a still, foot-sorted presentation marker, never a new terrain cell, inventory
item or operation target. Other terminal outcomes retain the hero; seeking before
death restores the hero. No marker is placed when the final position is absent.
`drawTombstone` in `src/dungeon-art.ts` shares the existing 16px grave artwork and
its palette/shading with observed graves; no new runtime PNG or vendor asset.

## Character sheet and backpack

The Backpack entry opens a wider character sheet: the existing hero portrait,
name and class, canonical health/energy/armor/level/strength/gold, then actual
worn equipment in a compact paper-doll board beside a complete carried-item list. The board remains
visible while the bag scrolls independently, including on phones.
Keep the close button visible while scrolling; use the available screen height.

Assignments come exclusively from `equipmentSlots`, with explicit left/right
rings, clothing layers, main/off hand, alternate weapon and quiver labels. A
multi-slot item appears once with all its assignments. Covered armor remains
listed. Do not parse decorated labels or infer a second hand for a two-handed
weapon. Missing assignments remain unknown; stale equipment has a visible notice.
Only complete current perception permits a list of unoccupied slots, and these
are not claims about available body parts or equip eligibility.

Item rows use shared perceived-appearance silhouettes and keep their full engine
labels. Quick actions prioritize the ordinary category action (or removal for
worn equipment) plus Drop, intersected with the engine's candidates. Selecting an
item opens all named candidate actions. All actions retain opaque IDs, revision
checks and real standing decisions. Dragging sends the public equipment action and selected slot;
there is no automatic replacement or confirmation.
No new art pack, PNGs or generated character sprites were introduced.

Journal scroll links require an engine-marked passage with at least four non-empty source lines. Short combat
notices, pet swaps and other one-to-three-line entries remain inline, regardless
of trailing blank lines or viewport wrapping. Opening-story auto-display uses the
same threshold; a full scroll preserves its original text and paragraph breaks.

New-character forms suggest a random, editable adventurer name with an explicit
reroll button. Suggestions use browser randomness independently of the world
seed. The chosen name is stored with the run and never regenerated on resume.
Workshop runs omit an explicit name and use the engine's existing name generator.

The ledger offers playback only when a committed public recording exists. Runs
without frames keep their statistics and a plain “No public recording” label.
“With replay” ranks recorded runs across the whole ledger, not just the current
top 100. Private account recordings are never exposed by this filter.

Ledger rows are compact: name/class, progress, outcome and an explicit Show replay
button in its own column. Missing recordings use a quiet dash with an accessible
label. The public dashboard contains adventures and replays only. Operational
diagnostics belong in Vercel Runtime Logs and Observability, not on this page.

The workshop chooser uses a bounded editorial layout: a serif invitation beside
a small selectable code preview, example cards, then private saved scripts.
The chooser scrolls normally at every viewport; only the open IDE uses a fixed
height. Keep its heading inside the viewport, with muted account context, full
touch targets and explicit empty saved-script guidance. No new art is required.

Agent-browser walkthrough corrections: mobile HUD uses canonical status labels,
keeps equipment on a single icon-and-name line, and places compact journal notes
below the measured HUD height. Sheets start directly below the site rail and
hide the underlying HUD. Workshop navigation resets page scrolling and stacks
mobile run buttons. Replay loading/error messages survive artwork and role redraws;
loading is never presented as an empty recording.

Hero HUD: level sits at the top right of the identity row, with reserved space so long names cannot overlap its label. Keep the complete accessible name even when its visible text is shortened. Health numbers sit beside Health. Suppress normal hunger/burden labels. Keep the equipped weapon on one line with its existing perceived-appearance icon, ellipsis and full-label tooltip.

Character sheet: portrait and canonical stats share the header with the HUD's
status formatter. Dungeon depth reads `lvl: N`; experience reads Hero level.
Equipment stays visible beside an independently scrolling bag. When the equipment
column has limited height, the board becomes a compact three-column slot grid,
including height-capped sheets on tall phones. Guidance stays above Automatic pickup.
Only current engine-provided equipmentTargets highlight; dropping sends the selected slot,
opaque item ID and captured revision. Tap Choose equipment slot, then a target,
provides the same explicit operation for touch/keyboard users. Item labels open
details. Free agent queries of the already active, certain run preserve the human
panel, equipment selection and focus. Agent inputs still invalidate old selection;
an old target touch never answers a standing question or retries at a new revision.
No automatic removal, replacement or warning confirmation. Text-map
access belongs only to Surroundings.

### Progressive replay delivery

The viewer reads a small static manifest and immutable compressed input chunks
from Blob/CDN. It runs the exact pinned WASM package locally and shows the first
scene before later chunks arrive. Seeking can use a preceding real checkpoint;
corrupt optional checkpoints fall back to the verified input log. Broken log
ranges stop playback with a clear error, preserving the last valid scene.

The range covers recorded input positions. Rejected attempts preserve the current
scene. Play, Pause and seek serialize reconstruction; replacing or removing a
viewer cancels its requests and workers. No account, ledger, upload or dynamic
replay request is needed to watch. The public component/runtime routes permit
ordinary cross-origin embeds. Embedding hosts must permit the module, static CDN
fetches, WASM and module-worker bootstrap under their own CSP.

For input archives, replayprogress reports indexed input count and replayload
means the first scene is ready, not that every chunk has downloaded. Historical
frame archives retain their buffered-frame event meaning. New account runs have
no Make public step; their unlisted replay link already grants read access.
Source projects and script notes remain private to their owner.

### Perception-only destination walking

Selecting a map square opens its perceived description and a free, revision-bound
C route preview. Sage ground markers show only returned known route steps. Walk
here, or double-clicking a map square, requests destination walking across the current level (at most 1,659 actions) through the same library
navigator used by agents. Reaching a destination never overrides a standing
choice, changed creature scene, damage, uncertainty or a level change. Each
executed step updates the human view and recording. Escape, blur, a hidden page,
opening a dialog or removing the component aborts subsequent steps. The final
unexpected stop reason remains visible; normal arrival is silent. Continuing requires another deliberate selection.

Distant tile descriptions come from the public actions query rather than invented
local affordances. Adjacent direct movement/interaction buttons remain distinct
from the walking policy. Arrows, lowercase NetHack directions and the direction pad still issue direct
single-step movement. Inspecting and previewing consume no game turn or randomness.

Cloud upload failures stay in the compact save status, with detail available on its tooltip. They never open the central gameplay error overlay.
### Encyclopedia

The game menu and a consistent open-book icon open the pinned engine’s encyclopedia
in a compact searchable book. Dotted creature/terrain names in inspection and item
detail titles are lookup buttons. Use only perceived appearance names, terrain
descriptions or the exact displayed item label; never infer an unidentified item
or creature identity. Category-only creatures offer the book’s search form.
Contextual lookup pre-fills and opens the entry with a return to inspection/item
details, provided the same game revision still applies. This first integration
does not turn arbitrary journal prose into inferred identities.
Look up a creature, item or place by name; show the engine’s wording with prose
lines reflowed into paragraphs for narrow screens. This is explicitly lore, not
identification of the perceived scene. Lookup costs no turns, changes no standing
decision, and needs no server. Missing entries invite another name. Search and
results work with keyboard and touch; late results from a closed book are ignored.

### Local play and background archives

Local IndexedDB is authoritative for play after the pinned engine is downloaded.
Cloud availability must not delay a locally available new game or resume. Background
sync batches changes since an acknowledged cursor every 30 seconds during activity
or 5 seconds after inactivity; outages stay quiet and queued work resumes online.
New runs append protocol inputs and completion records, with actual engine
checkpoints for faster restore. Compressed chunks and immutable manifests serve
replays directly from the CDN; playback makes no gameplay API requests. The PWA
caches the downloaded runtime for offline creation and local resumption. Older
published recordings retain their original format and use bounded frame batches.
Concluded/stale ledger admission and large-scale storage tuning remain tracked
in NEO-34; they are separate from the implemented local recording path.

### Bounded decision dialogs

Decision dialogs keep their title and cancellation controls visible; the shell never scrolls. Container transfers use compact 44px item rows in two independently scrolling lists, with selection counts, Clear selection and Apply transfers fixed below. Inspection messages expand in a bounded region. Reduce framing and spacing before shrinking readable text or touch targets.

### Failed-entry recovery

Browsers back up independently into durable streams within the private vault.
Opening a run on another device does not stop the original device’s sync. Old
shared-head conflicts recover into a separate stream while preserving both the
original cloud head and uncertain upload. The directory selects acknowledged
progress; gameplay and ledger publication do not wait for each other.
Other failed resumes offer Open local copy. Recovery skips remote restoration
and resumes the existing IndexedDB copy with its original engine, while always
backing up automatically in the background. Old `local=1` bookmarks are a
restore preference, never a sync opt-out; the flag is removed after entry.
There is no enable-sync switch. Temporary disconnection requires no user action.
It does not bypass damaged journals, missing runtime pins or another tab’s lock.
Every create/resume failure reports a bounded category and entry mode to private
Vercel logs; repeated attempts are not suppressed. Raw messages and save links
are never transmitted.

Local entry opens the existing device journal without downloading a cloud copy. New games never restore a vault. A fresh browser with no local run restores the acknowledged cloud branch. Different device branches are not silently substituted during local entry. Startup displays its current stage and reports bounded slow/complete/failure timings to private operational logs. New run recording appends individual protocol inputs and completion rows; walking never reads or rewrites historical recording rows.

The main game and workshop register a run in the vault directory before its first
background input upload. This cancellable dependency never delays local play;
registration failures retain the exact upload batch for retry. Metadata writes
coalesce the latest run state, and ledger availability does not gate input backup.

### Classic keyboard commands

Use the pinned Guidebook chapter 4 bindings, keeping arrow movement and dropping WASD. h/j/k/l and y/u/b/n step; uppercase directions execute one native game.run command, with engine stopping and no automatic fight. s searches, comma picks up, period waits, and < / > climb. a/w/d/c/q/r/z/t apply, wield, drop, close, drink, read, zap and throw. f/Z/x/p/E/Q fire, cast, swap, pay, engrave and ready quiver. i opens inventory; ? opens help. Direction decisions and tile inspection use the same lowercase direction layout. Shift-arrows still pan. Native runs settle as one operation; held lowercase movement retains the existing serial cadence. g/G map to game.run modes untilInteresting/pastBranches; m maps to moveWithoutAttack and combines with running via noPickup. F maps to attack. Counts 1–1000 before s or . request native search/rest once; other counted commands are rejected without input. An editable command box anchors beneath the hero, falling above when space is limited. It explains counts and prefixes and offers explicit clickable next-key completions, with a direction grid. Backspace edits, Escape cancels; menus, another action, blur and hidden tabs clear the draft. More actions provides the same command grammar through its focused search field. Completing a valid command executes once; invalid drafts remain editable and consume no input. Prefixes never answer a standing decision; never simulate them with ordinary attacks or auto-answer dialogs.

## Source-backed creature families

The user requested reusable base shapes with size and palette modifiers, without
spoilers. `art/monster-families.json` assigns broad source drawing groups and explicit
anatomy exceptions; `scripts/generate-monster-art.mjs` reads the pinned active roster
and generates `src/monster-appearances.ts`. Its only runtime key is the engine's
disclosed appearance. Never resolve ambiguous names using glyph, color or hidden
identity. No roster, mechanics, threat scale or bestiary is added to the game.

`src/creature-families.ts` holds 45 original outlined family masters, three authored
sizes and nine muted palettes. Recipes compose as `family.size.palette`; canvas
rasterizes to native pixels, keeping a common bottom-center ground anchor and the
full 16px interaction tile. Sizes and unnamed colors are artistic choices; source
size, color, resistance, attack and level fields are discarded. Color adjectives
already disclosed in appearance names may select paint. Existing early grids and
selected companion PNGs remain exact presets. Family sprites are bounded at 26px;
inspection magnification is separate from world size.

Missing, unsupported or ambiguous appearances use one fixed neutral cloud with a
question mark in both map and inspection. Neither cloud size nor paint changes with
glyph or color. Accessible labels say Unknown creature when appearance is absent;
a disclosed name remains readable even if art is ambiguous. Symbol mode preserves
the public engine glyphs. The question annotation renders above world sprites.

Run `node scripts/generate-monster-art.mjs --check` and
`bun scripts/render-monsters.ts` to verify coverage and export the transparent
135-variant atlas, manifest and family-only HTML proof under ignored
`test-results/art/monsters/`. The proof does not enumerate named species.

## Containers, sprite selection and fading death impressions

Recognizable chests, large boxes and ice boxes receive structured map appearances
from their rendered glyphs, including apparent disguises, with no contents, lock,
trap or magic disclosure. The shared chest master has a 16×12 chest and ice-box
variant and a 12×9 wooden box; inventory and ground use the same foot anchor.
Inspection titles and accessible map descriptions prioritize a perceived creature, then floor objects (including
current underfoot knowledge), then terrain. The object's icon accompanies its
name. Raised creature/object pixels select their ground square according to
foreground draw order; transparent padding does not steal clicks from the floor.

The user requested corpse-like impressions for six to seven game turns. These
are a cosmetic exception to the no-invented-props rule: `creatureDied` evidence
creates a flattened, muted impression beneath real objects and actors. It is
never an item, target, movement obstruction or corpse-production claim. Keep it
through age six, fade on ages five and six, and remove at age seven. Age uses
engine turns, never animation frames or free observations. Duplicate receipts
do not refresh it. Clear on run/level changes; render only on currently visible
squares. Missing appearance uses a neutral shape. Do not infer deaths from
disappearance, combat prose, damage, or kill counts. These temporary effects are
not persisted or recreated from old receipts on resume.

### Dedicated replay pages

Every public replay has a stable `/replays/{run-id}` page with its visible ID,
player, share URL and selectable embed code. Playback opens at the first recorded
input. Selected-moment details follow the actual displayed scene, including when
seeking back from a checkpoint; ledger totals never override its location, hero
level, turn or outcome. Peak progress, final/latest location, recorded turns,
outcome and date live in a separate, initially collapsed Run totals and outcome
disclosure so later events are not presented as the start of the adventure.
Missing metadata is labelled rather than inferred; optional ledger failures do
not gate static CDN playback. This page is unlisted and requires no sign-in.
The component shows a visible ID and link to this page for public replay sources,
including existing manifest and ledger URLs. Account input runs expose their
page directly. Older private frame recordings still require explicit publication;
private source, notes, saves and account metadata are never part of the link.
Use the component's shared controls in account playback too. Speeds range from
0.5× to 20×, default 4×; 10× and 20× are requested rates, bounded by reconstruction
and device speed. Only one input reconstruction runs at a time. No recorded
inputs are skipped or reordered to meet a rate, and Pause remains available
while reconstruction is in flight.
