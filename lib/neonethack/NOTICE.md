# Notices

`engine/` contains NetHack from https://github.com/NetHack/NetHack, based on
commit `04834a93165482a28257bac282543e3583658622`, with the project's headless port
and perception instrumentation. Original copyright and licensing notices are
retained. The controlling NetHack license is `engine/dat/license`; dated changes
are listed in `engine/CHANGES.neonethack.md`. Local preview distributions accompany
binaries with the matching project/engine source, Lua source archive and SDK
runtime source/notices. See [distribution instructions](docs/DISTRIBUTION.md).

Lua is used by the engine under its own MIT license. Native builds use the
caller's Lua development installation or the matching source preview's bundled
Lua archive. WASM distributions must retain the Lua
license alongside the engine license. Native installation extracts that notice
from the actual Lua header used to build the engine. WASM staging includes Lua,
Emscripten, musl, compiler-rt and LLVM libc notices from the selected toolchain.

The MCP adapter uses `@modelcontextprotocol/sdk` under its MIT license. The
TypeScript client itself does not import that SDK. Development tools are not
bundled into browser clients.

## Project code

A license has not yet been selected for independently owned project code and
original artwork. NetHack-derived code remains subject to its original terms.
Pixel-client asset attribution and separate terms are in
`web/neohack.dev/art/ATTRIBUTION.md` in the repository;
the pixel client is not included in the library archives.
