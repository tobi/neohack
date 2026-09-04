# Agent guidance

Read [PROJECT_PLAN.md](PROJECT_PLAN.md) for current execution state and open
issues, then [API_DESING.md](API_DESING.md) for the target contract.

## Architecture

- `lib/` is the semantic explorer core (C); the headless engine publishes
  non-mutating perceived belongings/terrain context. CLI and MCP bindings forward.
- `client/explorer-app.js` is the Lit application. `client/nh-map3d.js` is the
  reusable Three.js/Lit map component. They render observations, not engine rules.
- `client/recording.js` and `mcp/src/runs.ts` review public perception recordings
  without starting or commanding an engine. Replay must remain read-only.
- Core action boundaries record checkpointed public events. Existing input logs
  are not event recordings and must not be silently converted in place.
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
  or generated binaries/bundles. Incomplete reconstruction work is stashed
  locally until it compiles and passes its tests.

## Checks

- `bun run build` — engine, C bridge, local browser bundle.
- `bun test mcp/tests` — real-engine regressions plus pure recording tests.
- `bun mcp/accept.ts` — broader smoke suite; currently some scenarios are skipped.
- `bun mcp/smoke.ts` — live MCP wander, decisions, deterministic resume.
- `APP_URL=http://127.0.0.1:3311 bun run test:browser` — actual Chromium flows.

See [GOAL.md](GOAL.md) and [client/README.md](client/README.md) for run instructions.
