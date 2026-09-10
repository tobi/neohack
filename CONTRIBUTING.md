# Contributing to neohack

neohack is an alpha. Keep changes focused and include a reproduction and
relevant test results.

## Start here

- [Quickstart](lib/neonethack/docs/QUICKSTART.md) — build and play a fresh world.
- [Protocol](lib/neonethack/docs/PROTOCOL.md) — the supported public contract.
- [Library README](lib/neonethack/README.md) — build prerequisites and API surfaces.
- [AGENTS.md](AGENTS.md) — repository boundaries and source hygiene.
- [Security](SECURITY.md) — trust boundaries and private reporting.

Use fresh temporary game stores in tests, never player histories. Do not attach
private journals, engine pins, credentials or recordings to an issue or patch.

## Architecture and compatibility

`lib/neonethack/` owns the shared C semantic driver. Native and WASM use the same
game rules; TypeScript, MCP and examples consume the public API. A UI must not
infer hidden state, identify items by labels/slots, confirm warnings or repeat
occupations for the caller. Named operations and decision continuations remain
distinct.

Development saves are disposable. Remove obsolete formats and implementations
rather than adding migrations or compatibility loaders. This does **not** permit
weakening current-format integrity, journals, reservations, receipts or pending
decisions. A missing response is uncertainty, not permission to repeat input.

Protocol operations start in `lib/neonethack/protocol/catalog.ts`; response
shapes start in `lib/neonethack/protocol/response.ts`. Regenerate with
Node, review the generated C/TypeScript/schema diff, and check for drift. Private
C symbols use the `nnh_private_*` link namespace even in static libraries; only
`include/neonethack.h` defines the installed C API.

## Validation

From the repository root, with the prerequisites in the library README:

```sh
npm ci --ignore-scripts --registry=https://registry.npmjs.org --prefix lib/neonethack
node lib/neonethack/scripts/generate.ts --check
make -C lib/neonethack test
# MCP tests need Bun and the compiled WASM package.
make -C lib/neonethack wasm
npm test --prefix lib/neonethack
npm run --prefix lib/neonethack test:install
# Activate Emscripten 6.0.9, or set EMSDK to its installed SDK root.
make -C lib/neonethack wasm
npm run --prefix lib/neonethack test:wasm
npm run --prefix lib/neonethack test:browser
npm run --prefix lib/neonethack check:tools
```

Use sandbox-capable Chromium (`CHROMIUM` selects the executable). Never disable
the sandbox or weaken storage checks to get a green test. Missing coverage or a
skipped scenario is not a passing result. Describe host/toolchain blockers.
For pixel-client changes, also run:

```sh
bun install --frozen-lockfile --cwd web/neohack.dev
bun run --cwd web/neohack.dev test
```

Read the web client's AGENTS.md and DESIGN.md before UX edits. Human, accessible
and agent views must describe compatible perceived facts; eligibility is not
safety, and free observation must not consume input or randomness.

For hosting or cloud changes, build the library and web client first, then run
`npm test --prefix hosting/vercel`. For shared workshop examples, also run
`npm test --prefix examples/workshop`. Keep source docs, examples and current
behavior aligned; record limitations rather than treating a plan as implemented.

For distribution changes, run the complete
[checked preview and archive-consumer audit](lib/neonethack/docs/DISTRIBUTION.md).
A successful build alone does not validate the final archives.

## Source and dependencies

Retain upstream attribution, licenses and dated engine change notices. New
vendored engine files require `npm run --prefix lib/neonethack sources:update`
and review of `engine/SOURCES.json`. Do not bundle dependencies, SDK installations,
generated build/test output or local checkpoints as source.

CI uses read-only permissions and commit-pinned actions. Review upstream changes
before updating their hashes; keep dependency lockfiles in sync. The workflow builds
and audits preview archives; preview publication remains separate. The Vercel deployment workflow also deploys
main to neohack.dev; a push to main can therefore publish website changes.

When changing the pinned engine, update its dated change notes and run the
[engine fork audit](lib/neonethack/docs/ENGINE_FORK.md). Reuse the window port
where it preserves the actual perceived facts and input boundaries. Removing
a runtime hook requires native/WASM behavioral evidence; successful symbol
wrapping alone does not prove timezone, startup or replay equivalence.
