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
2. **Integrated — recording/replay.** C records public response checkpoints + ordered events and a byte-offset index. Read-only `/runs` endpoints and bounded paged replay client work. Legacy input logs now support explicit sandboxed reconstruction with unverified/read-only provenance.
3. **Integrated/browser-tested — Lit 3D viewer.** New `/play` is `client/explorer-app.js` + reusable `client/nh-map3d.js`. Local Lit/Three.js bundle; modeled actors/objects/terrain, camera/follow/cutaway/fallback, live controls, typed decisions, journal, library, timeline. No engine calls during replay (browser verified).
4. **In progress — verification/hardening.** Real browser flows, desktop/mobile screenshots, native acceptance, MCP smoke and regressions pass. All 15 current broad checks now pass with real fixtures, including level traversal and an interrupted multi-turn meal. This is not exhaustive coverage of every engine action. Address remaining scenarios, lifecycle/security edges and recording durability before declaring this pass complete.

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

- Latest green checks: `bun test mcp/tests client/tests/*.test.ts` = **68 tests / 814 assertions** (63 core/transport plus 5 presentation checks); native `test_explorer` green; MCP smoke PASS; broader MCP acceptance **15 pass / 0 skip**. Standalone real-browser GPU lifecycle tests also pass locally.
- Browser test `client/tests/browser.ts` passes live play/eat/confirmation/kick/save+resume, 3D rendering, read-only seek (0 core calls), and 390px mobile without overflow. Evidence `/tmp/ascent/takeover/browser-main/` and `/tmp/ascent/takeover/browser/`.
- Main server restarted under our ownership in Herdr pane **w2G:p8**, port **3000**, normal repo session root. At last check PID **3371760** (verify identity before stopping). Log `/tmp/ascent/takeover/front.log`.
- Older candidate server in pane **w2G:p7**, port **3311**, sessions `/tmp/ascent/takeover/dev-sessions`; it is stale. Current reconstruction candidate is pane **w2G:pC**, port **3312**, sessions `/tmp/ascent/reconstruction/browser-sessions`, last PID **3371764** (verify before stopping).
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
- Evidence: `/tmp/ascent/takeover/lifecycle/`. Main browser final evidence: `browser-final/report.json`. At that checkpoint main was pane w2G:p8, PID 2812439; use the latest service section before stopping anything.
- `tools/drain-server.ts BASE [--apply]` saves only worlds already loaded by that server; it never resumes an archived world. Used before each deployment; the loaded world stayed at T=14. All existing run data was preserved.
- The 3311 candidate server remains an older loaded bridge. Restart before comparisons. Upgrade all old bridges sharing a root before relying on leases; pre-lease binaries do not participate.

## Source control / private import

- User requested commits and private GitHub import to **tobi/neonethack**.
- Root Git repository initialized; `origin` is `https://github.com/tobi/neonethack.git` and GitHub visibility was verified PRIVATE before pushing.
- Commit history separates the licensed upstream snapshot (`04834a93165482a28257bac282543e3583658622`) from the explorer/viewer implementation and clean-checkout build fixes. The original nested `upstream/.git` remains intact locally; do not push to its public NetHack origin.
- SDKs, dependencies, build outputs, credentials, and run histories are excluded. A staged-file credential-pattern scan found no matching secrets.
- Fresh-clone validation caught missing CLI/play linkage and a missing headless entry in window-system metadata; both were fixed in source templates rather than relying on generated local Makefiles. A source-only fresh clone now builds and passes 24 tests, broader acceptance 10 pass/5 skip, and MCP smoke. Evidence: `/tmp/ascent/publish/fresh-check.log`.
- The original reconstruction scaffold was kept out of the initial publication. It has now been integrated with its implementation and tests; do not re-apply that old stash. Backups/design remain in `/tmp/ascent/reconstruction-wip/`.
- Future verified milestones should be committed and pushed to the private root origin. No force pushes or publishing runtime histories.

## Reconstruction pass (controller wake 3)

- Initial private GitHub CI run 33831623432 completed successfully.
- Implemented `lib/reconstruction.inc`: strict seeded NDJSON validation, original engine/static-data snapshots, lease checks, input-ID matching, bounded replay, public checkpoint capture, explicit unverified provenance, and read-only archive guards. Original run-data bytes are preserved.
- Added a separate management worker (`mcp/src/reconstruct.ts`) using bubblewrap/prlimit, not the live bridge queue. Only required source artifacts enter read-only; future saves/blobs and unrelated home files are hidden; networking is isolated. No unsandboxed fallback. Completed outputs are streamed/validated and symlinks rejected before publication.
- Browser and operator flows are available, with confirmation, job status, provenance banners, historical prompt display, and direct `?run=...&frame=...` replay links. Passive replay remains GET-only/engine-free. Host validation now closes the simple DNS-rebinding hole as well as enforcing Origin policy.
- Tests: 36 pass, 194 assertions locally, including sandbox isolation, denied source writes, hidden future data, unsafe publication artifacts, and timeout cleanup. Reconstruction UI and existing live/replay/mobile browser flows pass.
- Original seed904 (`/tmp/ascent/sess/mcp-mtm0m1ci-7pzwr`) reconstructed to **4,002 frames**. Final T=3640, position (17,3), HP38/38, XL3, AC6 and gold agree with the retained digest. This is endpoint corroboration, NOT full historical verification; warning remains.
- Main library archive: **r-2890f8eda1a84f6090b5daac5a0f8fd9**. Review at `http://127.0.0.1:3000/play?run=r-2890f8eda1a84f6090b5daac5a0f8fd9&frame=4001`. No source histories were uploaded to GitHub.
- Evidence: `/tmp/ascent/reconstruction/` (native/sandbox tests, browser-final, browser-live-final, seed-904-published.json, seed-904-comparison.json, seed-904-view-final). Main service was drained with its loaded world unchanged at T14 before restart.

## CI portability and terminal outcomes (controller wake 4)

- CI 33836551452 exposed Ubuntu's restricted-user-namespace AppArmor policy: bubblewrap failed setting up its private loopback. The same Ubuntu bubblewrap 0.9 binary works on the local unrestricted host. CI now installs a scoped user-namespace permission for the trusted `/usr/bin/bwrap` constructor and requires an actual namespace probe. No global AppArmor disable, retained capabilities, shared networking, skipped isolation tests, or unsandboxed fallback. Fix commit **70f586d** passed CI **33837129905**.
- Added engine `game_ended` facts from `really_done`, after life saving/wizard refusal and before disclosure. Death, escape, quit, ascent and engine errors are no longer inferred from narration. Older generic exits remain unknown. Final health, cause and turn survive cold replay; post-mortem inventory/status changes do not replace the final gameplay observation.
- Completed games retire their engine without invented disclosure answers; final observations and fatal-action receipts remain readable. Unexpected engine loss is `engineError`, not death. Shutdown has a two-second graceful budget, then kills/reaps a stuck child. A retired handle cannot append stale checkpoints to another owner's archive.
- Real engine tests now cover pet exchange, a locked door (actual failed-open cost is zero turns), fatal prayer, consent before surface escape, SIGKILL while an item choice is pending, and bounded SIGSTOP teardown/recovery. Three former broad-suite skips are now real tests. Level replacement and general multi-step interruption scenarios remain open.
- Browser terminal test confirms visible engine cause, HP0, disabled actions, exact recorded terminal facts, no death leaking into earlier frames, and **zero replay engine calls**. Existing live/play/save/resume/replay/mobile browser test is green on the rebuilt main server.
- Maintenance now skips readable-but-retired terminal snapshots. Its first candidate drain revealed this distinction; the isolated candidate then exited via ordinary bridge cleanup. Its retained live test world was explicitly recovered and saved at the same **T14**. Main was drained successfully before each restart, with T14 unchanged. A transport regression test and a real post-death candidate drain now pass.
- Evidence: `/tmp/ascent/ci-hardening/` (`tests-final.log`, `accept-final.log`, `smoke-final.log`, `native-test.log`, `browser-main-final/`, `browser-terminal-final/`, drain/recovery reports). All original run histories remain local and excluded from Git.

## Stairs, interruption and strict input boundaries (controller wake 5)

- Terminal milestone **2a245ee** passed CI **33838991531**.
- Staged a real seed-7 stairs route using public observations and named movement. The test exposed lost underfoot terrain after returning to a level. The engine now supplies visible `hereCmap` via its own read-only terrain renderer, guarded by floor observability and sight. No unseen traps or secret terrain are revealed. Descend/return and active-map replacement pass in native, MCP and browser tests.
- A real tourist meal exposed stale inventory at `Continue eating?` and a partially eaten meal mislabeled `blocked`. Perceptions now accompany semantic input boundaries, not only the next resting command. Normal meals emit structured `action_result` completion/interruption facts. The 6-turn meal, warning with already-bitten inventory, pending-warning resume, 2-turn declined continuation, fatal-safe retry machinery, stopped-meal resume and no implicit restart are tested. Other occupations do not yet have this structured coverage; no general engine-complete claim.
- Added C request-shape checks before input, reservation or checkpoint append: unknown/inapplicable/duplicate fields, malformed selectors, null/coerced guards, mixed answers, cardinality, unsupported actions, control/NUL characters and truncation limits. Invalid requests retain usable standing decisions. Unicode surrogate pairs are decoded correctly. Native raw UTF-8 fuzzing and broader semantic action conformance remain future hardening, not claimed coverage.
- MCP now forwards unknown fields for C rejection rather than silently dropping them, protects tool framing, rejects duplicate JSON keys before parsing loses them, and uses bounded UTF-8 frames. Reconstruction management also rejects ambiguous/extra confirmation fields. MCP advertises 0.6.0. No sandbox isolation changes or fallback.
- Browser scenario tests prove no map leakage across backward/forward level seeks, current partial-meal inventory at the warning, interrupted-meal review, and **zero replay core calls**. Found/fixed camera framing retained between different worlds with the same level ID: `<nh-map3d>` now accepts `worldKey` and the shell passes session identity. Browser verifies the new world's camera is reframed.
- Main was drained at unchanged **T14**, then restarted and browser-tested; original runs remain intact. Current candidate log: `/tmp/ascent/stairs-validation/candidate-front.log`. Evidence: `/tmp/ascent/stairs-validation/` (tests-final.log, accept-final.log, smoke-final.log, native-test.log, browser-scenarios-final/, browser-live/, browser-terminal/, browser-main/, drain reports). No run histories are committed.
- These engine additions apply to newly pinned engines. Older pins and original recordings are not silently rewritten/upgraded; capabilities/freshness reporting for older in-flight observations still deserves explicit treatment.

## Recording durability and read-only recovery (controller wake 6)

- **dacfaf9** passed CI **33842585203**, including the sandbox suite.
- `lib/recording.inc` now treats LF-committed checkpoints as authoritative. Under the run lease, complete journals reconcile stale counters and rebuild missing/torn/wrong indexes atomically. Sequences advance after data fsync, even if a cache commit fails. Data/input bytes are never silently rewritten or truncated.
- Native writers refuse corrupt/torn journals before new input (and before a resume engine starts). Recording failures expose live `recording` health separately from immutable deed receipts. Request watermarks and `gapBefore` mark unrecorded request boundaries on resume without inventing old observations. Missing receipts remain `incompleteRequest` even after hot-cache eviction; malformed frames cannot supply seemingly valid receipts.
- `mcp/src/archive.ts` and the read-only run store derive indexes/metadata in memory from validated prefixes. GET never repairs disk or calls an engine. Partial/corrupt/limited sources have explicit integrity notices; prefix exports carry a manifest so re-import cannot hide truncation. `?raw=1` preserves original bytes for diagnosis. Reconstruction publication still requires strict stored-index consistency, not this recovery fallback.
- Archive and lease access rejects symlinks/non-regular/multiply-linked files. New native UTF-8 tests reject malformed, overlong, surrogate and truncated encodings without a deed. Broader parser fuzzing remains open.
- Fault tests use real engines with a test-only fsync interposer (not production hooks), plus modeled crash artifacts. Data/index/metadata failure, counter lag, torn tails, poisoned old receipts, history gaps and sparse-file limits all pass. Review is bounded to 8 GiB / 100,000 frames, 8 MiB per frame and 32 MiB per page, with bounded scan concurrency/caching.
- Browser recovery test creates only its own isolated saved run, retains damaged evidence, verifies warning-preserving export/import and **zero replay core calls**, then restores that fixture. Live/replay/mobile, stairs/meal scenarios and reconstruction browser flows pass. Main was drained at unchanged T14 and restarted; final main browser flow is green.
- Original seed904 derived archive: **4,002 frames / 168,098,325 bytes**, canonical cold scan **~572 ms**, cached index **~0.42 ms** in the local probe. SHA-256 before/after matched. Final-frame deep-link browser review at T3640 passed with GET-only traffic; unverified reconstruction provenance remains unchanged. This is structural/read-only verification, not historical equivalence.
- Evidence: `/tmp/ascent/archive-recovery/` (tests-final.log, fault-tests2.log, accept.log, smoke.log, native-test.log, browser-final/, browser-main/, browser-scenarios/, browser-reconstruction/, browser-large/, large-readonly.json, drain reports). Candidate log: `/tmp/ascent/archive-recovery/candidate-front.log`.
- Deliberately still open: explicit preserved-copy salvage for torn checkpoint data, full private-sidecar/input-journal recovery, and power-loss coverage beyond these injected boundaries. See `docs/RECORDING_RECOVERY.md`. No original runs or engine pins were upgraded or uploaded.

## Viewer lifecycle, accessibility and standalone build (controller wake 7)

- **bfbc747** passed CI **33848188525**.
- Split the presentation-only component into procedural models (`nh-map3d.js`), renderer/input lifecycle (`map-surface.js`), and pure bounded preparation (`map-presentation.js`). No engine or transport dependency was added.
- Actual WebGL loss/restoration cycles, failed/partial initialization, render exceptions, retry, 2D switching and detach/reconnect are tested. Restoration rebuilds the latest observation. GPU contexts, observers, controls, textures and geometry are released; explicit 2D preference survives reconnect.
- Rendering is now on-demand and settles instead of drawing continuously. Hidden/off-screen views stop rendering. Reduced motion and discontinuous world/level changes snap positions. Texture pruning and bounded material keys prevent growth across glyph/color changes; water/lava are instanced.
- Replaced the non-interactive ASCII fallback with a bounded, labeled keyboard grid. Arrows inspect, Enter selects, Home/End/Page keys navigate, Escape leaves map focus. Map keys no longer leak into game movement; the game controls have their own focusable keyboard zone. Fixed Escape cancellation when a decision button/input is focused, verified against a real prayer.
- Large-scene policy is explicit: 20,000 accepted cells, ±10,000 integer coordinates, 512 detailed feature/actor/object cells, and an 80×24 2D window. Excess complexity uses usable 2D rather than allocating unbounded models. Fit uses projected bounds rather than clipping large maps. A 20,000-cell illustrative fixture rendered in ~1 second locally, with its projected extent inside the viewport; this is a presentation benchmark, not a game scenario.
- `bun run build:component` creates the standalone single-file ESM bundle plus demo, README, optional source map and dependency licenses in `client/dist/standalone/`. Repeated imports share the registered constructor. No generated artifacts or extra license grants were committed.
- `bun run test:component` serves only the built artifact, creates its own sandboxed headless Chrome profile/CDP endpoint, verifies ownership, tests real context loss/recovery, and cleans up. It does not attach to the user's browser or provide a game API. CI now runs this test and uploads a private `nh-map3d` artifact on success; no `--no-sandbox` workaround.
- Candidate live/replay/mobile, renderer+keyboard integration, stairs/meal, terminal and recording-recovery browser flows pass. Main's original 4,002-frame deep link also passes with GET-only traffic and unchanged unverified provenance. Static assets were rebuilt; **no backend restart was needed** and the existing service PIDs remain unchanged.
- Evidence: `/tmp/ascent/viewer-lifecycle/` (tests-final.log, isolated-final/, renderer-final/, live-final/, scenarios-final/, terminal-final/, recovery-final/, main-large/). Browser checks are not a complete cross-browser or screen-reader audit.

## Next continuation priorities

1. Check the new private CI run after this milestone. Keep sandbox isolation genuinely exercised, without an unsandboxed fallback. Preserve honest unverified legacy provenance.
2. Add explicit preserved-copy salvage if extending damaged journals; never auto-truncate or erase reservations. Audit private-sidecar/input-log integrity and older-pin perception freshness. Broader parser fuzzing, life-saving and other occupation fixtures remain open; do not re-stage the already passing stairs/meal cases.
3. Build richer inspect-self/here panels using returned data; extend cross-browser/accessibility checks where useful. WebGL recovery, bounded large maps and standalone packaging are now tested, not future placeholders. Keep owned browser-test tabs/profiles cleaned up; do not touch unrelated tabs.
4. Harden receipt/recording failure recovery without undoing the fail-closed reservation behavior. Consider immutable template/options/time provenance as well as engine binary pins for truly historical replay; don't assume seed alone controls calendar-dependent NetHack behavior.
5. Reconcile retired sources/docs and engine conformance/WASM compatibility only after inspecting real changes; do not blindly regenerate vectors. Update test counts/known gaps and complete controller 1 only when done criteria are genuinely met.

## Baseline evidence / prototype

- Review: `/tmp/ascent/review/REVIEW.md` and evidence directory.
- Temporary top-down Lit prototype: `/tmp/ascent/viewer/`, isolated server on 3310. This is a UX/transport baseline, not the requested final 3D viewer.
- The pre-takeover front was replaced only after verification. Current service ownership is listed above; do not kill unrelated browser/dev processes.
