# Pixel NetHack: a place worth descending into

## The destination

A small, lovingly drawn world with real depth: heavy stone walls, worn floors,
quiet pools of lantern light, and an unmistakable sense that someone built these
rooms before the adventurer arrived. A compact HUD and field notes on demand keep the interface out of the world. It makes NetHack approachable without making its
choices for the player.

This is the visual target, not a claim that every feature below is implemented.
The first interface is a foundation. The dungeon art must develop beyond uniform
flat square tiles before we call it finished.

## View, geometry and depth

- Orthographic, three-quarter pixel view. Keep NetHack's square grid and eight
  directions legible. No perspective distortion or isometric input mapping.
- World cells use a native 16×16 footprint. Human figures are 16×32 with a stable
  bottom-center anchor. Display at integer scales; disable canvas smoothing.
- **Walls have height.** Draw distinct top/cap planes, dark vertical faces,
  lighter upper edges, courses of masonry and a small ground-contact shadow.
  Corners, intersections, door jambs and narrow corridors must connect plausibly.
  Use neighbor masks to select geometry, not a disconnected cube per cell.
- A six-to-eight-pixel apparent rise is the initial target. Keep passages readable;
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
game observation. Unknown cells stay dark and contain no seeded hints.

The seed changes surface treatment only. It never changes terrain, doors, room
connectivity, visibility, movement, encounters, item identity or engine results.
No decorative pathfinding or creature AI runs alongside NetHack's rules.

### Passage edges and actor motion

Corridors use connected 16px worn treads, distinct from room slabs. Stone shoulders
frame the outside edges of the perceived passage with a raised cap and recessed
face. These shoulders stay within known cells. A known adjacent surface opens the
whole edge; an unexplored end gets a dark central notch, not a solid closure.
Side shoulders follow the known run, with corner openings for diagonal links.
These are cutaway trim, not collision facts. The notch marks uncertainty, not a
promise of a traversable route. No exterior
wall cells, exits or hidden floor are fabricated. Corners and junctions follow the
currently supplied neighbors and update as exploration reveals more.

The primary LimeZu premade characters retain their original appearance. Each uses
six authored frames for each of four idle and four walk clips, on a 16×32 canvas,
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
  space remains empty. Sight comes from the engine's optional `cell.visible`,
  never a client sight radius. Fade sight changes over 240 ms, and glide the camera
  over 110 ms after a confirmed step, rounding drawing positions to native pixels.
  Neither animation queues input or delays the next turn. Reduced motion settles
  immediately. Use View Transitions for panel changes, not per-turn map snapshots.
- Welcome: one clear beginning, a name, three valid starting paths, an optional
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

## Assets and release

Use the pixel-art-interfaces skill and its assets with provenance. Export only
the few finished-project assets in use, include exact terms and visible credit,
and keep the private pack/catalog/viewer out of the repository. Editable recipes
and original rendering code belong beside the example.

The desired product is a beautiful free-to-play revival. That is not a blanket
asset redistribution license. NetHack attribution and NGPL terms remain intact;
the owner must resolve independently owned code and art licensing before public
release. No automatic deployment or publication is part of this implementation.

## Acceptance checks

Inspect native and 2× renderings; desktop and 390px browser screenshots; corners,
T-junctions, doors on each side, isolated pillars, narrow corridors and irregular
rooms. Verify seeded repeatability, meaningful variety across seeds and no marks
on unknown cells. Verify camera/resize stability, real engine turns, every supported
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
An accessible Begin button walks the approach automatically. Cancel returns the
traveler outside the threshold. Stop movement on blur, menus, visibility loss and
release. Reduced motion removes interpolation without changing input or entry.

Load public client libraries and warm the pinned WASM package in the background
while the player explores the title courtyard. Intro art and movement must not wait
for engine downloads. Warmup downloads files only: no engine, save-store lock or
session until starting/resuming an adventure or explicitly invoking a WebMCP tool.
Entering early waits for preparation with input reserved once, never queues duplicate
starts. Immutable package URLs share the browser cache with the eventual worker;
saved adventures retain their original engine package. Idle title tabs do not compete
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
serialize access with human input, retain uncertain requests, and keep package pins
for saved games. Never auto-answer warnings or repeat uncertain input with a new ID.
Unsupported browsers keep the human game fully functional; do not claim a JavaScript
shim is native WebMCP. Document capability detection and test the browser registration
contract plus actual engine calls.

### Creature recognition and local interaction

Use the engine's optional `occupant.appearance` to name the displayed creature and
choose species art. A visible newt is recognizable by looking; fighting is not an
identification requirement. This is the apparent form, never the hidden identity
of a disguised creature. Do not parse combat prose into identity. Older pinned
packages and hallucinated observations may omit the field; show a category and
explain the question mark in inspection rather than inventing an identify action.

Inspection leads with the clicked occupant, a sprite portrait and an Ally/Creature
label. Terrain titles apply to empty tiles. Moving toward an ally may swap places;
moving toward another creature may attack. Make this clear on the action buttons.
Keep risky actions secondary and provide a compact close control. No auto-action on
inspection or focus. All attempts use the API's action offer and observed revision.

Within the sprite pass, draw ground loot and fixtures first, then all mobile actors
in foot order. Never suppress a ground object because its cell has an occupant.
Raised silhouettes extend above their anchor tile instead of resembling floor decals.
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
