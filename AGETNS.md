# Agent guidance

Read [PROJECT_PLAN.md](PROJECT_PLAN.md) for current execution state and open
issues, then [API_DESING.md](API_DESING.md) for the target contract.

## Architecture

- `lib/` is the semantic explorer core (C); `lib/request_validation.inc` rejects
  malformed intents before input/reservations. The headless engine publishes
  perceived belongings/terrain at semantic input boundaries and structured
  terminal/meal/study results and witnessed life saving. `lifeSaved` never
  means game over; narration alone is not outcome authority. CLI and MCP
  forward; never silently strip bad fields.
  Engine menu `selectable` and `menu_object` facts bind offered objects; never
  infer identity from labels, accelerator assignment or row order. Choice IDs
  are returned integers accepted unchanged by `choose`; item refs stay strings.
  Older pins lacking object bindings fail explicitly instead of being upgraded.
  Equipment dispatch/candidates use class, current usage and engine physical
  armor access; never select armor removal for a ring or infer layers from labels.
- `client/explorer-app.js` is the Lit application. The reusable map is
  `nh-map3d.js` + `map-surface.js` + `map-presentation.js`: procedural models,
  GPU/keyboard lifecycle, and pure bounded display preparation. No engine rules.
  Map-focused keys inspect, never act; game shortcuts belong outside map focus.
- `nh-inspection.js` / `inspection.js` render self/here/tile facts from the
  current observation, never stored cell objects. Equipment use comes from the
  engine's `usage` fields, not label parsing. Respect `perception` freshness;
  missing legacy metadata is not permission to claim current/empty information.
- `client/recording.js` and `mcp/src/runs.ts` review public perception recordings
  without starting or commanding an engine. Replay must remain read-only.
- Legacy reconstruction is a separate explicit management operation:
  `lib/reconstruction.inc` + `mcp/src/reconstruct.ts`. It runs in a dedicated
  sandbox, preserves source data, and publishes only validated, unverified,
  read-only archives. Never add an unsandboxed fallback.
- `lib/recording.inc` commits public checkpoints; their indexes are caches.
  Corrupt/torn data blocks new input and is never silently truncated. Read-only
  review (`mcp/src/archive.ts`) can expose a validated prefix with a persistent
  integrity notice. Read `docs/RECORDING_RECOVERY.md` before changing recovery.
- `lib/input_integrity.inc` / `lib/sidecar_integrity.inc` validate private history
  and semantic boundaries. Missing/corrupt metadata is not optional cache data.
  `recoveryRequired` blocks deeds; never clear boundary flags or reservations to
  force continuation. Replay mismatches abort our child, not an implicit answer.
- Explicit `tools/salvage-run.ts` preserves a leased source into a new external
  evidence bundle and a warning-labeled prefix export. It never executes a pin,
  repairs a live world, or drops reservations. Never install evidence as a live
  session or remove boundary flags to force continuation.
- `tools/review-bundle.ts` / `mcp/src/bundle-review.ts` page one public-only
  salvage recording. Keep them free of engine/core/MCP/reconstruction imports.
  Public SHA-256 matching is not private-evidence verification or authenticity.
  Never expose manifest paths, pins, journals or raw damaged tails over HTTP.
- Existing input logs are not event recordings and must not be silently
  converted in place. Missing receipts stay uncertain even across marked gaps.
- Existing sessions and unrelated upstream changes must be preserved. Engine
  executables are pinned per run to keep resume from silently switching versions.
- One bridge owns a live run via `.lease`. Never bypass the lease or delete it
  while a world is active. Use read-only archives to inspect another owner's run.
- Request reservations are durable. Missing receipts are uncertainty, not
  permission to execute a request again; see `mcp/tests/lifecycle.test.ts`.

## Rules

- Named actions, explicit self/here/direction targets, opaque item references,
  typed decisions, and authoritative observations after actions.
- No message/keyboard choreography in the browser; never auto-confirm warnings.
- Full live/replay observations share one renderer. Do not carry future terrain
  backwards when seeking.
- Unknown information stays unknown. No unseen monsters/traps/item properties.
- Test actual scenarios. Missing scenarios are SKIPs, not vacuous passes.
- Do not claim the entire design is implemented: see the verified milestones and
  remaining work in the plan and runbook.

## Source control

- The project repository is the root Git repository; `origin` is private
  `tobi/neonethack`. Commit verified milestones and push completed work there.
- `upstream/.git`, when present locally, is the preserved original NetHack
  checkout. Do not push project changes to its public NetHack origin. The root
  repository vendors the source tree with its original license and base SHA.
- Never commit session histories, credentials, SDKs, dependency installations,
  or generated binaries/bundles. Keep unfinished work out of verified commits;
  the original reconstruction scaffold has now been integrated and tested.

## Checks

- `bun run build` — engine, C bridge, local browser bundle.
- `bun test mcp/tests client/tests/*.test.ts` — engine, storage, transport and pure presentation checks.
- `bun mcp/accept.ts` — 15 real broad checks, currently no skips; not exhaustive engine coverage.
- `bun mcp/smoke.ts` — live MCP wander, decisions, deterministic resume.
- `APP_URL=http://127.0.0.1:3311 bun run test:browser` — actual Chromium flows.
- `bun run test:browser:scenarios` / `test:browser:terminal` — real level/meal/death review (set `APP_URL` for the candidate).
- `test:browser:recovery` / `test:browser:storage` require the candidate's isolated `/tmp` `BROWSER_SESSIONS_DIR`; they must not target production.
- `bun run build:component` builds the self-contained ESM distribution; `bun run test:component` uses its own sandboxed Chrome/static-only fixture. Never bypass Chrome or reconstruction sandboxing to make CI pass.
- `test:browser:renderer` also checks keyboard/game isolation on an isolated candidate.
- `test:browser:inspection` covers zero-turn facts, pending decisions, replay/import races, legacy unknowns and mobile focus.
- `test:browser:salvage` creates its own isolated native fixture, retires it, then verifies engine-free import/review of the copied prefix.
- `test:browser:pickup` exercises real two-object menu controls, pending save/resume, single-object selection and engine-free backward/forward review.
- `test:browser:equipment` covers ring candidates, Left/Right choice, pending resume, the Remove control and read-only equipment history.
- `test:browser:lifesaving` / `test:browser:study` use natural seeded fixtures, explicit player consent, preserved decisions and engine-free historical review.
- `test:browser:bundle` starts/stops its own dedicated CLI and uses explicitly illustrative >128 MiB size data; it verifies paging, cache limits, provenance and zero game/management traffic.

See [GOAL.md](GOAL.md) and [client/README.md](client/README.md) for run instructions.
