# neonethack

Fresh library-first repository. The supported implementation lives entirely in
`lib/neonethack/`; `examples/` and `example/pixel-bun/` are clients of its public
API. Do not restore the old Bun server, UI, generic public `act` tool or retired
JS semantic adapter.
Legacy services are retired; do not recreate their local runtime aliases.

## Development compatibility

- Backwards compatibility is not a requirement. Replace old implementations and
  delete obsolete code, formats, fallbacks and generated artifacts outright.
- Do not add migrations, compatibility adapters, legacy runtime loaders or package
  archives to preserve old development saves. Those saves are disposable; start
  fresh after an incompatible change.
- Keep current-format integrity checks and durable request/receipt guarantees.
  Never silently replay an old save on a different engine or treat an uncertain
  request as permission to execute it again.

## Boundaries

- Public contract: `lib/neonethack/docs/PROTOCOL.md`, generated JSON schemas,
  `include/neonethack.h`. `protocol/catalog.ts` generates C dispatch metadata,
  TypeScript requests and MCP tool schemas. Regenerate with Node; check drift.
- `src/explorer.*` and private headers are internal. Native and WASM share this
  C semantic driver; worker/TS/MCP code must not acquire game rules.
- Named operations are distinct from answering/cancelling a standing decision.
  Never infer item identity from labels, inventory slots or menu order. Do not
  auto-confirm warnings, repeat occupations or expose hidden state.
- Preserve input journals, request reservations, static data/engine pins and
  pending-context integrity. Missing receipts mean uncertainty, not permission
  to execute again. Corrupt data is not silently truncated or repaired.
- Discovery describes actual backend guarantees. Memory is volatile; IndexedDB
  requires explicit origin/name ownership and awaited pre-input transactions.
  WASM resume needs the same package, not an automatic binary upgrade.

## Checks

```sh
make -C lib/neonethack test
npm ci --prefix lib/neonethack
npm test --prefix lib/neonethack
make -C lib/neonethack wasm
npm run --prefix lib/neonethack test:wasm
npm run --prefix lib/neonethack test:browser
node lib/neonethack/scripts/generate.ts --check
```

Use actual engine/browser scenarios. Missing coverage is not a passing test.
Never disable Chromium sandboxing, weaken storage checks or rewrite recordings
to make a test pass. Native C calls must not change the host's signal handlers.

## Source and release hygiene

- Never publish local sessions, private journals/pins, credentials, SDK installs,
  dependencies or generated build output as source. Release binaries are separate
  artifacts accompanied by licenses and matching source.
- NetHack notices and base attribution remain intact. Its NGPL obligations apply
  to derivatives. Publication/own-code licensing needs owner approval.
- This work prepares `tobi/neonethack`; do not push or change visibility without
  an explicit request. No commits are implied by passing local tests.
- Existing local sessions are not migration fixtures. Test with new temporary
  stores only. Public distribution guidance is `lib/neonethack/docs/DISTRIBUTION.md`.
  During release preparation an ignored local `lib/neonethack/PLAN.md` may hold
  agent checkpoints, workstation paths and service bookkeeping. Never publish it.
