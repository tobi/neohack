# Local distributions and release gate

This repository currently prepares **local previews**, not approved releases.
The package is private. No script publishes npm packages, uploads artifacts,
creates tags, pushes Git or changes repository visibility.

Passing packaging checks is not release approval. Review the [runtime profile
and replay limits](REPLAY.md), final archive/source/attribution checks and the
owner's licensing decision before distribution.

## Build a checked preview

Prerequisites: the native Linux build tools, Node/npm, GNU tar and an installed
Emscripten **6.0.9** SDK. A sandbox-capable Chrome/Chromium must be available for
browser checks (`CHROMIUM` overrides the executable). From the repository root:

```sh
EMSDK=/absolute/path/to/emsdk \
  npm run --prefix lib/neonethack package:preview -- /tmp/neonethack-preview
```

The output directory must not exist. The script takes an explicit source
snapshot without changing Git staging, includes hash-checked Lua 5.4.9 source
and the actual SDK's runtime sources/headers/notices, and builds in that copy.
Source checks reject symlinks at fixed source roots and every inventory parent,
not just leaves. The source tree must remain trusted and stable while it is
being snapshotted; these checks are not a hostile-filesystem race sandbox.
It runs C, native Node, WASM and sandboxed browser integration tests and an
installed public C client. It then independently extracts the finished archives,
checks every source/runtime hash and artifact inventory against the actual SDK,
compares shipped notices with their included source, installs the npm tar
into a fresh consumer, runs native/WASM/MCP gameplay and an installed CMake/C
client, and rebuilds/retests the extracted source without the builder's outputs.
npm dependencies are installed from the lock file
with dependency lifecycle scripts disabled. Compilation remains native/WASM C;
there is no JS rules implementation.

Successful output contains:

- `neonethack-VERSION-source.tar.gz`: project/engine sources, examples, build
  recipes, Lua source archive, Emscripten runtime source/headers and source hashes.
- `neonethack-VERSION-linux-ARCH.tar.gz`: C library/header/CLI, engine, static
  data, CMake/pkg-config metadata and notices. It is built for the current host,
  **not** a portable binary for every Linux/glibc version.
- `neonethack-VERSION.tgz`: TypeScript/Node/MCP interfaces, shared-core WASM,
  schemas, documentation, inline source maps and runtime notices.
- `SHA256SUMS`, `PREVIEW.json`: matching archive hashes, source identity, WASM
  identity, build epoch and an explicit `publicationApproved: false` marker.
- `audit/AUDIT.json`: independent archive-consumer and extracted-source rebuild
  results, including archived and rebuilt WASM IDs (not required to be identical
  across toolchains/hosts). `audit/` contains test worlds/builds, not distribution.
- `work/`: retained build/test workspace for inspection, **not an artifact to
  distribute**. It contains generated output and temporary test worlds.

Native and source archives have explicit file lists. Saves, bones, live logs,
playgrounds, local SDK binaries/cache, dependencies and Git metadata are not
copied by recursive release-tree packaging. Keep all three matching archives
and checksums together; moving binaries without their corresponding source and
notices is not this distribution recipe.

To independently repeat the archive audit against a **trusted local preview**:

```sh
EMSDK=/absolute/path/to/emsdk npm run --prefix lib/neonethack test:archives -- \
  /path/to/preview /tmp/new-neonethack-audit
```

The audit output must be new. Archive bytes, header checksums, names, file types,
permissions, duplicates and source manifests are checked before extraction.
Links/devices/PAX overrides and traversal are refused. The audit subsequently
executes the trusted binaries/source: hashes are not authentication or an OS
sandbox. It does not alter the original archives and retains failed workspaces.
Do not run it against an arbitrary uploaded archive. Current limits are 512 MiB
expanded tar and 40,000 headers, with the GNU-long-name subset used by this recipe.

## Rebuild from the source archive

Extract it and read `SOURCE-MANIFEST.json`. With the external SDK/tooling
installed, follow the library README. Native and WASM builds prefer the included
Lua archive; no Lua development installation is needed for that source bundle.
Unset `LUA_HOME` to use the included native Lua source. Ordinary source builds
without that archive can still use a system Lua 5.4 installation.

The runtime source copy is not a complete Emscripten/LLVM compiler distribution.
Use the external 6.0.9 SDK. The manifest records source bytes and the original
`SOURCE_DATE_EPOCH`; pass that epoch when rebuilding. This recipe does not yet
promise bit-for-bit identical binaries across hosts or different toolchains.

## npm safety checks

`npm pack` runs `prepack`: typecheck/build, generated-schema drift check, source
fingerprint/provenance validation, WASM hash/manifest checks, dist allowlists and
notice/source-map checks. Run `make wasm` after changing source before packing.
A TS build may update private worker files but will **not** bless a damaged
compiler output by regenerating its checksum. Deliberately rebuild it instead.

`engine/SOURCES.json` is an explicit vendored source inventory. Maintainers add
new engine files with `npm run sources:update`, then review the diff. Ordinary
builds and source-archive consumers do not require Git. It is not an engine pin
or a game-history migration mechanism.

## Publication remains a separate owner decision

NetHack's NGPL requires preserving notices, marking changes, applying its terms
to derivatives and satisfying its executable/source distribution conditions.
Its archive-site alternative is specifically limited to noncommercial
redistribution; the preview recipe instead accompanies binaries with source.
Lua and the embedded Emscripten runtimes retain their own notices/licenses.

The owner's grant for independently owned new code still needs an explicit
scope/decision. Third-party notices and this build recipe do not make that
choice. Complete the remaining release audit and owner review before changing
`private`, uploading binaries or pushing a public repository.

### Owner release checklist

1. Choose an explicit license and scope for independently owned code. Retain
   NetHack's terms for its derivatives and every third-party notice; seek legal
   review if the combined/standalone boundary is unclear. This document makes
   no choice or grant for the owner.
2. Approve the exact repository, visibility and **source tree/history** to make
   public. A clean candidate tree does not prove an existing repository's old
   commits are publishable. Never publish preserved local history, aliases,
   private checkpoints or workspaces merely because current files pass checks.
3. Authorize and review CI on that intended remote platform. Locally passing
   GCC/Clang, browser and archive-consumer tests are not a remote CI result.
4. Review the chosen version, package metadata, platform claims and matching
   source/native/npm identities. License/version/source changes require a fresh
   build and archive audit. Preserve complete original runtimes for old worlds;
   no version bump authorizes replacing their pins or migrating their settings.
5. Separately authorize any push, tag, upload or registry publication. The
   current preview builder/auditor deliberately expects a private package and
   `publicationApproved:false`; it is not a publishing command. Any release
   mode or metadata change must itself be reviewed, not bypassed to make these
   checks green. Distribute only approved artifacts and matching source/notices,
   never `work/`, `audit/` or player stores.

Completion of the local engineering checklist is not completion of these owner
approval steps. This alpha covers the advertised catalog, not every NetHack
command or every possible historical runtime/platform.
