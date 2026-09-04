# Project takeover — execution plan

User authorization: implementation changes throughout the project are now permitted. Preserve existing runs and unrelated work. Aim: one semantic C engine API, thin transports, and a polished Lit/web-component 3D viewer for live play and event-based review.

Continuation controller: idle loop **1** (30-wake bound). Keep this plan current and state remaining work honestly.

## Definition of done for this implementation pass

- Core regressions from `/tmp/ascent/review/REVIEW.md` fixed with actual scenario tests: free food discovery, correct candidates, missing targets, changed-payload retry rejection, door terrain semantics, movement outcomes.
- No duplicate NetHack prompt logic in frontend. Explicit self/here/direction actions and typed decisions work.
- Every action has authoritative observation, actual time cost, coherent inventory; errors preserve a usable decision.
- Versioned public perception recordings, explicit reset/delta semantics, deterministic pure client reducer, seekable replay that does not send commands to the engine. Old recordings preserved; unsupported formats explained honestly.
- Lit shell + reusable 3D map component, clear hero/pet/object rendering, camera controls/follow, high-contrast map and status, item/action controls, target selection, journal, decisions, run library, replay timeline and transport.
- Browser tests cover new game, move, inventory/eat, confirmation/cancellation, targeting, save/resume, replay seek/no-engine-actions, desktop/mobile layout, WebGL failures.
- Server uses safe paths, explicit API errors, bounded requests, and local assets rather than fragile runtime CDN dependencies where practical.
- Docs and tests describe real coverage; no vacuous scenario passes or implementation-complete claims for unimplemented features.

## Stages

1. **Baseline repairs verified — core reliability.** Non-mutating engine perceptions replace pickup/inventory peeks; actual object classes and identities; target decisions; complete retry fingerprints; door symbols; conditions; pending-decision resume; engine pinning; existing-id truncation rejection. Real regressions pass. Further validation/lifecycle scenarios remain.
2. **Integrated — recording/replay.** C records public response checkpoints + ordered events and a byte-offset index. Read-only `/runs` endpoints and bounded paged replay client work. Legacy input logs are listed honestly; explicit isolated conversion is still pending.
3. **Integrated/browser-tested — Lit 3D viewer.** New `/play` is `client/explorer-app.js` + reusable `client/nh-map3d.js`. Local Lit/Three.js bundle; modeled actors/objects/terrain, camera/follow/cutaway/fallback, live controls, typed decisions, journal, library, timeline. No engine calls during replay (browser verified).
4. **In progress — verification/hardening.** Real browser flows, desktop/mobile screenshots, native acceptance, MCP smoke and regressions pass. The old broad suite now correctly reports 10 pass / 5 skip. Address remaining scenarios, legacy conversion, lifecycle/security and recording durability before declaring this pass complete.

## Known baseline failures

- Repo browser expects old `awaiting`/flat world and submits dropped `{move}`/`{key}` fields.
- Floor candidate lookup calls pickup and mutates time/inventory.
- Substring food matching offers spears (`pear`).
- Missing kick target yields `needsChoice` with no decision.
- Retry fingerprints omit item/target and most decision arguments.
- Open doors classified as walls; move/wait bypass effects; capped message count breaks new-message detection.
- Slot-based item IDs are not stable identities; durable cause/replay metadata incomplete.
- Existing MCP acceptance has 3 no-op tests and several weak scenario assertions.

## Verified milestone and service ownership

- Latest green checks: `bun test mcp/tests` = 24 tests / 133 assertions; native `test_explorer` green; MCP smoke PASS; broader MCP acceptance 10 pass / 5 skip.
- Browser test `client/tests/browser.ts` passes live play/eat/confirmation/kick/save+resume, 3D rendering, read-only seek (0 core calls), and 390px mobile without overflow. Evidence `/tmp/ascent/takeover/browser-main/` and `/tmp/ascent/takeover/browser/`.
- Main server restarted under our ownership in Herdr pane **w2G:p8**, port **3000**, normal repo session root. At last check PID 2812439 (verify identity before stopping). Log `/tmp/ascent/takeover/front.log`.
- Candidate server in pane **w2G:p7**, port **3311**, sessions `/tmp/ascent/takeover/dev-sessions`. Its bridge process must be restarted to pick up rebuilt C changes.
- Old review prototype remains in pane w2G:p6, port 3310; it is not the active application.
- Latest additions are rebuilt and deployed on the main endpoint: `observation.here`, close-on-exec session pipes, CLI SIGPIPE handling, bridge decoder/deadline fixes, and replay race/picking refinements. Main-browser live/replay/mobile checks and the baseline regressions were re-run green after that deployment. The lifecycle pass below is now also deployed and verified. The candidate 3311 bridge may still be an older loaded process; restart it before backend comparisons.
- Root package/build scripts and `bun.lock` now pin Lit/Three.js. Prettier is a dev dependency; formatting with mise failed due an unrelated global reshim GitHub rate limit, so project-local Prettier is used.

## Lifecycle pass (controller wake 1)

- Added per-run `.lease` ownership using kernel flock. A competing bridge cannot resume or end another bridge's world. After a handoff, semantic metadata is reloaded rather than reusing a stale cached sidecar.
- The engine retains only its own run lease until exit. A fault-injection test pauses an engine, kills its bridge, and proves that the world remains locked until the engine retires. Other engines do not inherit each other's leases or pipe handles.
- Added durable `requests.seen.jsonl` reservations before engine input. Older complete receipts are lazily recovered from public recordings instead of being forgotten after the 64-response hot cache. Missing receipts return `incompleteRequest`/unknown, and torn request journals fail closed without sending a command. Input logs and semantic sidecars are fsynced.
- Fixed sidecar receipt-order restoration and strengthened generated run-id uniqueness.
- Ten real lifecycle tests now cover competing bridges, handoff, cold item/target decisions, crash/confirmation receipt, >64 receipt retention, uncertain reservation, torn journal, engine-held lease after owner crash, and multiple worlds. Native C also tests competing handles within one process.
- Tests: 24/24, 133 assertions; native C acceptance green; MCP smoke PASS. Browser live/replay/mobile test passed again after final deployment (0 replay engine calls).
- Evidence: `/tmp/ascent/takeover/lifecycle/`. Main browser final evidence: `browser-final/report.json`. Main service remains pane w2G:p8, current PID 2812439 (verify before stopping).
- `tools/drain-server.ts BASE [--apply]` saves only worlds already loaded by that server; it never resumes an archived world. Used before each deployment; the loaded world stayed at T=14. All existing run data was preserved.
- The 3311 candidate server remains an older loaded bridge. Restart before comparisons. Upgrade all old bridges sharing a root before relying on leases; pre-lease binaries do not participate.

## Source control / private import

- User requested commits and private GitHub import to **tobi/neonethack**.
- Root Git repository initialized; `origin` is `https://github.com/tobi/neonethack.git` and GitHub visibility was verified PRIVATE before pushing.
- Commit history separates the licensed upstream snapshot (`04834a93165482a28257bac282543e3583658622`) from the explorer/viewer implementation and clean-checkout build fixes. The original nested `upstream/.git` remains intact locally; do not push to its public NetHack origin.
- SDKs, dependencies, build outputs, credentials, and run histories are excluded. A staged-file credential-pattern scan found no matching secrets.
- Fresh-clone validation caught missing CLI/play linkage and a missing headless entry in window-system metadata; both were fixed in source templates rather than relying on generated local Makefiles. A source-only fresh clone now builds and passes 24 tests, broader acceptance 10 pass/5 skip, and MCP smoke. Evidence: `/tmp/ascent/publish/fresh-check.log`.
- Incomplete legacy reconstruction scaffolding is deliberately **not committed**: local stash `WIP: isolated legacy reconstruction scaffolding (requires reconstruction.inc)` (currently stash@{0}); full backups and detailed next-step design are in `/tmp/ascent/reconstruction-wip/`. Apply it only when continuing implementation and keep it out of verified commits until complete.
- Future verified milestones should be committed and pushed to the private root origin. No force pushes or publishing runtime histories.

## Next continuation priorities

1. Implement explicit **isolated** legacy input-log → public-perception conversion, without overwriting source runs or using viewer playback to send commands. Respect run leases and pinned legacy engine versions. Validate input logs before reconstruction; label unverified reconstruction honestly. Old engines lack the new terrain/item perceptions, so support observed-glyph fallback or report limits; do not claim unknown historical state is exact.
2. Replace remaining skip scenarios with actual bounded pet/locked-door/level/death/interruption tests. Add structured engine terminal results rather than relying on arbitrary text; strict request validation, recording/index recovery, and bounded teardown still need work.
3. Improve viewer interaction/accessibility/performance, WebGL fallback/recovery and larger maps; add inspect-self/here panels using returned data. Publish a standalone component bundle. Clean up owned browser-test tabs after evidence capture; do not touch unrelated tabs.
4. Harden receipt/recording failure recovery without undoing the fail-closed reservation behavior. Consider immutable template/options/time provenance as well as engine binary pins for truly historical replay; don't assume seed alone controls calendar-dependent NetHack behavior.
5. Reconcile retired sources/docs and engine conformance/WASM compatibility only after inspecting real changes; do not blindly regenerate vectors. Update test counts/known gaps and complete controller 1 only when done criteria are genuinely met.

## Baseline evidence / prototype

- Review: `/tmp/ascent/review/REVIEW.md` and evidence directory.
- Temporary top-down Lit prototype: `/tmp/ascent/viewer/`, isolated server on 3310. This is a UX/transport baseline, not the requested final 3D viewer.
- The pre-takeover front was replaced only after verification. Current service ownership is listed above; do not kill unrelated browser/dev processes.
