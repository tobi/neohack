# Dungeon art workshop

The live map and this CLI share `src/dungeon-art.ts`: original pixel drawing code,
with 16px cells, joined wall caps, eight-pixel front faces, staggered paving,
crevice moss and silhouettes for actual known features. There are no copied vendor
tiles in this renderer. Character art used by the interface has separate provenance.

From `example/pixel-bun/` after `bun install`:

```sh
bun scripts/render-dungeon.ts --layout art/layouts/rooms.txt --seed 314159 --scale 3 --out test-results/art/rooms.png --verify
bun scripts/render-dungeon.ts --compare 1,314159,8675309 --scale 2 --out test-results/art/comparison.png --verify
bun scripts/render-dungeon.ts --layout art/layouts/geometry.txt --seed 42 --scale 1 --out test-results/art/native.png --verify
```

The comparison command defaults to both complete sample layouts. Repeat `--layout`
to compare other inputs. `--scale` accepts integer 1–6; `--help` lists every option.
Chromium must be installed; `CHROMIUM` can override `/usr/bin/chromium`. A temporary
loopback Bun server is closed with the sandboxed browser after rendering. No engine
or saved game is required. All generated PNGs and JSON receipts belong under ignored
`test-results/art/`, not the source release.

Each receipt records the exact input SHA-256, renderer source SHA-256 and version,
seed, dimensions, pixel scale, browser version and output SHA-256. `--verify` compares
actual canvas pixels for repeatability, reversed input order, camera cropping,
variation across seeds, omitted and explicitly unknown cells, and future terrain
values. Tests also compare PNGs from independent browser launches. An empty `checks`
array means verification was not requested, not that any checks passed.

## Explicit ASCII legend

This is an art interchange format, not a parser for every NetHack terminal dump.
In particular, **`#` always means a corridor**. Walls are `|` and `-`; no symbol is
guessed from neighboring cells. Spaces and missing trailing columns remain dark.
Unsupported symbols (including tabs and unexplained creature letters) are rejected
with their exact line and column.

| Symbol | Meaning | Symbol | Meaning |
| --- | --- | --- | --- |
| `.` | Room floor | `#` | Corridor |
| `-`, `\|` | Wall | space | Unknown |
| `+` | Closed door | `/` | Open door |
| `<` | Stairs up | `>` | Stairs down |
| `~` | Water | `}` | Lava |
| `{` | Fountain | `_` | Altar |
| `@` | Floor and explicit gold player marker | `^` | Generic known trap |
| `T` | Tree | `"` | Grass |
| `I` | Ice | `=` | Iron bars |
| `\\` | Throne | `K` | Sink |
| `]` | Bridge | `X` | Grave |

## Why the art stays stable

The seed selects a coherent limestone, slate or warm stone material and paver size.
Staggered slab seams are derived from absolute world pixels, so they join across
cell boundaries. Independent integer hash channels control block repairs, chips
and sparse detail. Fixed coordinate districts affect dampness without creating
rectangular changes of wall color. No unseeded randomness, camera coordinates,
render order, turns or mutable room-component IDs enter the surface hashes.

Neighbors affect only structural joins, shoreline and contact shading. As a new
cell is discovered those joins may update truthfully; existing material and paving
do not shuffle. Render with all supplied public cells, even when the camera crops
them, so a viewport edge does not remove a known neighbor. All drawing is clipped
to a supplied known cell: wall faces never paint unknown space or cover another
cell's actor. Callers draw current objects and occupants after terrain.

The live interface includes the public level ID with the actual game seed. To
reproduce that surface in the CLI, pass the same combined string to `--seed`.
The seed changes appearance only, never geometry or game rules. No invented
chests, torches, creatures or collectible props are sprinkled into the map.

`geometry.txt` concentrates isolated pillars, T/cross junctions, narrow passages,
doors on all four sides, concave rooms and every feature. `rooms.txt` and
`waterworks.txt` test broader compositions. Inspect both native and enlarged PNGs;
pixel invariants do not establish artistic quality or gameplay correctness.
