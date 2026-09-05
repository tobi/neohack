# Notices and publication status

`engine/` contains NetHack from https://github.com/NetHack/NetHack, based on
commit `04834a93165482a28257bac282543e3583658622`, with the project's headless port
and perception instrumentation. Original copyright and licensing notices are
retained. The controlling NetHack license is `engine/dat/license`; dated changes
are listed in `engine/CHANGES.neonethack.md`. Local preview distributions accompany
binaries with the matching project/engine source, Lua source archive and SDK
runtime source/notices. See `docs/DISTRIBUTION.md`; this is not a publication grant.

Lua is used by the engine under its own MIT license. Native builds use the
caller's Lua development installation or the matching source preview's bundled
Lua archive. WASM distributions must retain the Lua
license alongside the engine license. Native installation extracts that notice
from the actual Lua header used to build the engine. WASM staging includes Lua,
Emscripten, musl, compiler-rt and LLVM libc notices from the selected toolchain.

The MCP adapter uses `@modelcontextprotocol/sdk` under its MIT license. The
TypeScript client itself does not import that SDK. Development tools are not
bundled into browser clients.

**Publication decision still required:** no new license grant has been selected
for the standalone project code. `package.json` remains private until the owner
chooses one and the complete release notice/asset audit is done. This file does
not grant a license on the owner's behalf. NetHack's NGPL requires derivatives
containing its code to retain its terms; choosing a permissive license for new
standalone wrappers does not relicense the combined engine.

No session histories, private journals, engine pins, credentials, SDK installs,
or generated game recordings belong in source or npm packages.
