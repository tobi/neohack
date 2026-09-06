# Pixel NetHack

A lantern-lit, approachable NetHack client. Bun serves the interface; the existing
neonethack WebAssembly package runs the shared C semantic driver and game engine
in the browser. This example is a client of the public API, with no game rules or
gameplay HTTP routes. It lives at `example/pixel-bun/` as a standalone example.

## Run

From the repository root, build the library once:

```sh
npm ci --prefix lib/neonethack
npm run --prefix lib/neonethack build
# Activate your installed Emscripten SDK, or set EMSDK to its absolute path.
make -C lib/neonethack wasm
bun install --cwd example/pixel-bun
bun run --cwd example/pixel-bun build
bun run --cwd example/pixel-bun start
```

Open http://127.0.0.1:3333. `PORT` changes the port. The server binds to loopback,
serves only `public/` and the library's `dist/` under `/runtime/`, and has no
upload/action/session endpoints. Serve only these public runtime assets.
The client typechecks against the public library declarations. At runtime it
imports the public `client.js` and `wasm.js` modules, keeping the WASM package
together. The renderer knows presentation, never collision, identity or combat.

### Remote access and browser saves

Use HTTPS when opening the game from another computer. Plain HTTP on a LAN IP
or remote hostname is not a secure browser context: Web Locks are unavailable
and the game cannot safely open persistent saves. For an embedded preview, the
outer page must also be secure; opening the game's secure URL in a new tab can help.

Configure an HTTPS reverse proxy for remote access. Saves belong to the exact
browser origin: changing the hostname, scheme or port opens a separate save
collection. Use a current browser with site storage allowed.

## The visual workshop

[DESIGN.md](DESIGN.md) defines the art target: raised connected walls, coherent
seeded materials, varied paving and weathering, with no hidden-state hints.
The CLI and live map share the terrain renderer; the game's actual seed plus
its public level ID drive stable surface variation.

```sh
bun run --cwd example/pixel-bun art:render --layout art/layouts/rooms.txt --seed 42 --out test-results/art/rooms.png --scale 3
```

See [art/README.md](art/README.md) for the ASCII legend, comparison sheets and
repeatability checks. Generated art stays under ignored `test-results/`.

## Play

Walk the traveler into the entrance hall with the overlaid arrows, keyboard or
Begin button. Then choose a name and one of all thirteen NetHack starting classes.
All thirteen classes use the same native 16×32 character scale. Valkyrie, Wizard
and Ranger use their default character selections.
The courtyard is a separate tutorial: it creates no engine session or turns. An optional seed
is available. Tap an arrow key or direction button for one step; hold to walk.
The first step is immediate, repetition starts after 240 ms and continues at up
to ten steps per second, awaiting each durable engine result. Rapid deliberate
taps keep at most one extra step buffered; held repeats never build a queue.
Release cancels future repeats. Walls, nearby perceived creatures, damage,
decisions, uncertainty, menus and focus loss stop walking. Other actions remain
one-shot: holding search, wait or an occupation does not repeat it.
The Field guide lists shortcuts, diagonals, free inspection and map panning.
Use the backpack or action buttons; each selected item is sent by its public ID.
Directions, warnings, item choices, single/multiple choices and text are explicit
decisions. Escape cancels only when the API says the decision is cancellable.
Unknown decisions fail closed. No warnings are confirmed and no occupations
are repeated automatically. A stale choice remains visible after a rejection.

The map renders remembered terrain and only the current public occupants/objects.
Explored terrain outside engine sight stays dim and gray, with a brief fade.
Door results and other short messages appear in temporary action bubbles on the
map. A completed silent search shows “You search nearby.”; discoveries use the
engine's actual messages. The journal retains feedback without repeating the
entire message history each turn. Warnings still require explicit decisions.
Pixel illustrations represent visible creature and item categories. The Art/Symbols map
button switches between illustrations and NetHack symbols; inspection and the text map always retain them.
Corridors have connected stone shoulders with recessed openings at unknown edges.
The traveler uses authored four-direction idle/walk clips, faces observed movement,
and respects reduced motion. These animations never submit game inputs.
Confirmed steps glide over 110 ms without waiting to accept the next input;
sight fades over 240 ms. Panels use View Transitions where supported.
The title screen is a separate decorative scene. The map has a text
alternative and nearby-cell descriptions. UI labels remain live HTML, with
keyboard focus, modal dialogs, reduced-motion support and narrow-screen layouts.

## Saves and uncertainty

Browser IndexedDB uses the explicit store `neonethack-pixel-bun-v1`. It requires
Web Locks and a secure context (localhost or HTTPS), with one owner per origin
and store. Saves are committed by the library before input is acknowledged.
There is no memory fallback. The adventure index (names, IDs, role, seed, last turn and
any unresolved request) is localStorage metadata; it is not a replacement journal.
The exact outgoing request is recorded in that metadata before it is forwarded;
failure to record it prevents input. Malformed metadata is reported, not silently
reset. The UI offers an explicit
same-request receipt check after uncertainty and blocks further game input until
it resolves. A failed transport must be reloaded and the same world resumed first.
Creation/resume are never automatically retried.

Closing a world or reloading preserves the game and its standing decision.
Clearing browser site data deletes it. Different origins/ports have separate saves.
Old worlds are not supported across incompatible rebuilds.
No service worker upgrades or automatic game-version replacements are installed.
The visible journal contains observations received since opening the adventure;
the underlying game journal remains owned by the library.

## Check

```sh
bun run --cwd example/pixel-bun test
```

Uses actual engine worlds in sandboxed Chromium (`CHROMIUM` can override its path),
fresh browser stores, all thirteen starting paths, no-turn inspection, held movement,
bounded tap buffering, release/blur/wall stops, one-shot actions, item cancellation,
a warning across abrupt reload, ownership exclusion,
static-server boundaries and desktop/mobile screenshots. Generated screenshots
live in ignored `test-results/`. No saved user games are test fixtures.

## Credits

See [art attribution](art/ATTRIBUTION.md) for sprite sources and terms, and
[NetHack and dependency notices](../../lib/neonethack/NOTICE.md).

## Development saves

Only the current package under `/runtime/wasm/` is supported. Builds replace it;
there are no package archives, legacy loaders or save migrations. Old development
saves are disposable. Start a new adventure after an incompatible rebuild and
clear browser site data if the old save index is no longer useful. Storage schema
upgrades replace the old database contents outright. Current-format reloads still
preserve exact receipts and standing decisions.

## Fullscreen HUD and browser agents

The map fills the viewport. Health and conditions remain visible; backpack,
surroundings and journal open on demand. The corner menu holds saved adventures,
help, map controls, the text map, fullscreen mode and credits.

For a runnable agent walkthrough, see [Play with agent-browser and WebMCP](../../lib/neonethack/docs/AGENT_BROWSER.md).

Every MCP tool is also registered through native WebMCP when the browser supports
it. Agent actions use the same durable engine and update the visible HUD. See the
library [WebMCP guide](../../lib/neonethack/docs/WEBMCP.md) for capability detection,
receipt semantics, package pins and native browser verification.

The title courtyard loads its art independently, imports the public libraries in
background, and warms the current (and latest saved) engine package in the browser
cache. It does not open IndexedDB or create an engine until starting/resuming or an
explicit WebMCP call. Returning to the doorway releases ownership. Two active game
tabs still cannot write the same store; close the other game tab before resuming.

New engine packages expose apparent creature names from their displayed glyphs.
Recognizable creatures need no attack or identify action to lose the question mark.
Unidentified appearances retain the category fallback. The example includes original
newt, jackal, lichen, goblin, kobold and rat sprites in `src/symbol-art.ts`.
Ground loot renders below actors and appears in a free-to-read, clickable list at
the right. Pickup uses explicit item IDs and the displayed revision.
