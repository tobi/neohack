# Agent guidance

Read [PROJECT_PLAN.md](PROJECT_PLAN.md) for current execution state and open
issues, then [API_DESING.md](API_DESING.md) for the target contract.

## Architecture

- `lib/` is the semantic explorer core (C); `lib/request_validation.inc` rejects
  malformed intents before input/reservations. The headless engine publishes
  perceived belongings/terrain at semantic input boundaries and structured
  terminal/meal results. CLI and MCP forward; never silently strip bad fields.
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
- `test:browser:recovery` requires the candidate's isolated `/tmp` `BROWSER_SESSIONS_DIR`; it must not target production.
- `bun run build:component` builds the self-contained ESM distribution; `bun run test:component` uses its own sandboxed Chrome/static-only fixture. Never bypass Chrome or reconstruction sandboxing to make CI pass.
- `test:browser:renderer` also checks keyboard/game isolation on an isolated candidate.
- `test:browser:inspection` covers zero-turn facts, pending decisions, replay/import races, legacy unknowns and mobile focus.

See [GOAL.md](GOAL.md) and [client/README.md](client/README.md) for run instructions.
