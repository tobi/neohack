# Command and knowledge coverage — NEO-28

The shared protocol now has **45 methods, including 37 game operations**. It executes throwing and the final sacrifice, alongside spells, skills and manual interactions. Isolated engine fixtures demonstrate invocation and a genuine ascended result. **No legitimately completed start-to-ascension run has been demonstrated.**

## Reconciliation and evidence

This follows NEO-26's attached 129-entry inventory and evidence, reconciled against clean main `33aa6c1` (NEO20–27 in `85f158e`). Its original 27-method changing-tree audit is historical evidence, not a frozen release contract. The starting main already had 29 methods including loot/configurePickup, canonical self-state, warnings, position/text prompts, disclosed perception, receipts and lifecycle recovery. Those implementations and fixtures are retained.

Sources: [NetHack 5 Guidebook](https://nethack.org/v500/Guidebook.html), [engine command table](../engine/src/cmd.c), [generated catalog](../protocol/catalog.json), [shared driver](../src/explorer.c), [headless item binding](../engine/win/headless/winheadless.c), [known information projection](../engine/win/headless/knowledge.inc).

## Reviewable increments

1. Engine object-bound menus, counts, typed direction/floor-selection context; throw and offer.
2. Cast/enhance, ranged and weapon controls; deliberate interactions and movement; engine apply/read/equipment exceptions.
3. Known item/spell/skill/overview/conduct/achievement facts and genuine final score.
4. Generated C/TS/MCP/WebMCP contract, generic accessible browser controls and verification. Pixel UX integration is tracked separately in NEO-29 through NEO-32.

Initial selectors answer only their first item/target. Subsequent choices remain standing decisions. Ordinary whole-inventory attempts avoid exposing hidden engine candidate rankings. Counts preserve actual engine stack/turn behavior, and malformed quantities are refused. Remaining English-prompt handling outside the newly typed getobj/direction/floor paths is not claimed eliminated.

## Scenario coverage

| Paths | Fresh real engine evidence | Limits |
| --- | --- | --- |
| Throw / counted drop | Shared native/WASM manual-actions contracts: explicit item and direction, partial stack, zero-turn cancellation, stale decision, lost response exact retry, conflicting payload, close/resume | Unprefixed throw/fire may produce engine multishot. No synthetic repeated input. |
| Offer | Native high-altar fixture; shared native/WASM acquisition-wish and altar fixture, explicit floor confirmation and bound Amulet menu, terminal score and cold receipt | Isolated prepared world; no legitimate full run. |
| Spells / skills | Shared controlled force-bolt menu/target/replay; earned dagger advancement and known rank | Spell-specific secondary effects and every skill are not exhaustively covered. |
| Item chains | Wand break warning/cancel, magic marker → separate paper → text, dip → separate potion → naming text; rub/invoke distinguish real commands | No assumption every apply/read object effect is covered. |
| Ranged / weapon slots | Quiver/set/clear, fire target/cancel, empty-quiver selection/cancel, explicit swap and two-weapon enable/disable/refusal, hands wield | No automatic ammo selection, weapon substitution or combat. |
| Commerce / engraving / movement | Actual shop debt/chat and itemized bill selection/cancellation/resume; hands/text/append consent and real interruption; forced attack and no-fight single step | Every shopkeeper service and terrain combination is not exhaustively covered. |
| Equipment exceptions | Towel wear/remove across resume and meat-ring hand choice | Other equipment occupations retain existing shared fixtures. |
| Artifact and ritual | Actual Heart of Ahriman invocation; seven-candle attachment, Candelabrum light, Bell and Book create invocation area/stairs | Artifact invocation is distinct from the ritual. |
| Knowledge | Identified charges/beatitude returned; identical unknown objects with different charges/curses yield identical public objects; repeated observe pure | No raw hunger, prayer, spell-memory or skill-practice counters. Existing unseen trap/monster, sleep/paralysis and perception fixtures retained. |
| Browser | Throw target and engraving text survive reload; real UI controls and existing IndexedDB ownership, corruption, lost receipt and lifecycle suites | Pixel UI controls are follow-up tasks; no sandbox/storage integrity bypass. |

Test sources: [manual-actions contracts](../tests/manual-actions-contracts.mjs), [controlled command contracts](../tests/manual-fixture-contracts.mjs), [offering contracts](../tests/offer-contracts.mjs), [native offering](../tests/offer.test.mjs), [browser](../tests/wasm/browser.test.mjs). Validation results are recorded on NEO-28; unexecuted or failing coverage is not counted as passing.

## Validation at review handoff

All reported tests ran in fresh temporary worlds/stores; no skipped cases are
counted as passing. Native and WASM use the same shared scenario contracts.

| Check | Result |
| --- | --- |
| `make -C lib/neonethack test` | 5 C checks passed |
| `npm test --prefix lib/neonethack` | 167 tests passed |
| `make -C lib/neonethack wasm` | Build passed |
| `npm run --prefix lib/neonethack test:wasm` | 85 tests passed |
| `npm run --prefix lib/neonethack test:browser` | 20 sandboxed browser tests passed |
| `npm run --prefix lib/neonethack test:install` | 4 static/shared install and consumer checks passed |
| `bun run --cwd web/neohack.dev test` | Typecheck/build and 73 tests passed |
| `node lib/neonethack/scripts/generate.ts --check` | No generated drift |
| `git diff --check` | Passed |

The counted item layout changes the public C ABI to **2**; rebuild C consumers.
The semantic protocol remains version 1. Current package/data pins and pending
context integrity remain mandatory. No save migrations, commit, push or deployment
are included in this handoff. NEO-28 attachments record source hashes and results.

## Remaining intentional omissions

Role/form/intrinsic operations (jump, ride, monster ability, turn undead, intrinsic teleport), sit/wipe, lock forcing, disarming, tip, bulk undressing/drop, arbitrary naming/annotation, spell reordering and general options remain unsupported. The existing container protocol selects whole transfer stacks. Initial quantities are supported only by drop; subsequent engine item menus advertise counted selection explicitly. Free observations do not provide a complete enlightenment/discovery/kill-history encyclopedia. Known properties and dungeon overview are bounded projections; unknown fields remain absent.

Auto-travel, repeated occupations, raw keys/act, debug commands, host shell and save migrations remain excluded. Engine-controlled multishot/occupations/involuntary time are not new opportunities for client input.

## Route feasibility versus fixtures

Ordinary movement, combat, equipment and item operations provide plausible traversal and survival paths. Quest leaders can initiate dialogue; chat was never proven a universal ascension prerequisite. Apply/read implement the ritual ingredients; the actual ritual chain now has fixtures. The final offer command now exists and produces the engine's real ending and score. Quest completion, all planes and a complete normal route have not been demonstrated by these fixtures. No optimal route, readiness oracle or survival guarantee is provided.

## Full ordinary-command matrix

This preserves NEO-26's inventory of every non-debug/non-internal extcmdlist entry (129), including aliases and compile-conditional host commands. Supported means a real binding, not exhaustive coverage of every effect. Partial states its limitation; unsupported is absent; excluded is intentionally outside the protocol. The engine's 41 debug/internal entries remain excluded.

| Engine entry | Status | Current binding or omission |
| --- | --- | --- |
| `#` | Excluded | Docs/discovery/pinned identity replace engine command-entry UI; no raw command string. |
| `?` | Excluded | Docs/discovery/pinned identity replace engine command-entry UI; no raw command string. |
| `adjust` | Excluded | No inventory letters or terminal control; client presentation owns layout. |
| `annotate` | Unsupported | Client notes do not perform engine naming or artifact creation. |
| `apply` | Partial | Whole-inventory attempts permit engine exceptions; wand warning, marker second item/text, ritual and prior position/study fixtures tested. Not every object effect is covered. |
| `attributes` | Partial | Canonical self-state plus structured spell/skill/conduct knowledge. Not every enlightenment property. |
| `autopickup` | Supported | Existing game.configurePickup replaces supported ground-pickup settings with journaled explicit rules. |
| `bugreport` | Excluded | No host/process/report/debug commands; source may be compile-conditional. |
| `call` | Unsupported | Client notes do not perform engine naming or artifact creation. |
| `cast` | Supported | game.cast presents the learned-spell menu and subsequent engine targets. No strategy or automatic spell choice. |
| `chat` | Supported | Distinct named game operation, explicit engine items, text, targets and confirmations. See scenario matrix; subeffects are not exhaustively covered. |
| `chronicle` | Partial | Structured disclosed non-spoiler achievements, attained ranks and final roleplay entries. Hidden prize identities omitted. |
| `close` | Shipped | Named game operation; success, time and decisions remain engine-owned. |
| `conduct` | Partial | Structured engine conduct counters; special roleplay conducts and the entire interactive display are not yet projected. |
| `dip` | Supported | Distinct named game operation, explicit engine items, text, targets and confirmations. See scenario matrix; subeffects are not exhaustively covered. |
| `down` | Shipped | game.climb with up/down direction. |
| `drop` | Supported | game.drop supports explicit {id,quantity} partial stacks. No bulk droptype operation. |
| `droptype` | Unsupported | Bulk drop is absent; individual counted drop is supported. |
| `eat` | Partial | Food plus broad attempts for perceived non-food diets; engine decides actual edibility and danger. Existing interruption/warning fixtures retained. |
| `engrave` | Supported | Distinct named game operation, explicit engine items, text, targets and confirmations. See scenario matrix; subeffects are not exhaustively covered. |
| `enhance` | Supported | game.enhance executes earned skill advancement; observation.knowledge.skills is free inspection. |
| `exploremode` | Excluded | No host/process/report/debug commands; source may be compile-conditional. |
| `fight` | Supported | game.attack forces one directional attack. game.moveWithoutAttack supplies one no-fight/no-pickup step. Other movement prefixes remain excluded. |
| `fire` | Supported | Distinct game.fire/quiver/swap/twoWeapon controls; no autoquiver or fire-assist substitution. Explicit hands/slot/target choices. |
| `force` | Unsupported | No public named binding. See full audit for alternatives and their limits; pay is needed for paid shopping. |
| `genocided` | Partial | Public observation/actions cover only part of manual information; no complete view parity claim. |
| `glance` | Partial | Public observation/actions cover only part of manual information; no complete view parity claim. |
| `help` | Excluded | Docs/discovery/pinned identity replace engine command-entry UI; no raw command string. |
| `herecmdmenu` | Partial | Public observation/actions cover only part of manual information; no complete view parity claim. |
| `history` | Excluded | Docs/discovery/pinned identity replace engine command-entry UI; no raw command string. |
| `inventory` | Partial | Public observation/actions cover only part of manual information; no complete view parity claim. |
| `inventtype` | Partial | Public observation/actions cover only part of manual information; no complete view parity claim. |
| `invoke` | Supported | Distinct named game operation, explicit engine items, text, targets and confirmations. See scenario matrix; subeffects are not exhaustively covered. |
| `jump` | Unsupported | No public named binding. See full audit for alternatives and their limits; pay is needed for paid shopping. |
| `kick` | Shipped | Named game operation; success, time and decisions remain engine-owned. |
| `known` | Partial | Known current item identity/beatitude/charges/enchantment/proofing. No complete historical discovery encyclopedia or hidden artifact-power list. |
| `knownclass` | Partial | Known current item identity/beatitude/charges/enchantment/proofing. No complete historical discovery encyclopedia or hidden artifact-power list. |
| `look` | Partial | Public observation/actions cover only part of manual information; no complete view parity claim. |
| `lookaround` | Partial | Public observation/actions cover only part of manual information; no complete view parity claim. |
| `loot` | Partial | Existing game.loot handles perceived floor containers and staged whole-stack transfers. Saddle interaction and arbitrary container counts remain absent. |
| `monster` | Unsupported | No public named binding. See full audit for alternatives and their limits; pay is needed for paid shopping. |
| `name` | Unsupported | Client notes do not perform engine naming or artifact creation. |
| `offer` | Supported | game.offer executes actual sacrifice; bound floor corpse or carried item. Genuine high-altar ascension fixture and engine final score. |
| `open` | Shipped | Named game operation; success, time and decisions remain engine-owned. |
| `options` | Partial | Ground-pickup subset via game.configurePickup. Other general options and persistence commands are excluded. |
| `optionsfull` | Partial | Ground-pickup subset via game.configurePickup. Other general options and persistence commands are excluded. |
| `overview` | Partial | Remembered levels, annotations and bounded feature counts from engine mapseen; not a complete overview rendering. |
| `pay` | Supported | Distinct named game operation, explicit engine items, text, targets and confirmations. See scenario matrix; subeffects are not exhaustively covered. |
| `perminv` | Excluded | No inventory letters or terminal control; client presentation owns layout. |
| `pickup` | Shipped | Named game operation; success, time and decisions remain engine-owned. |
| `pray` | Shipped | Named game operation; success, time and decisions remain engine-owned. |
| `prevmsg` | Partial | Public observation/actions cover only part of manual information; no complete view parity claim. |
| `puton` | Supported | game.equip/remove selects exact carried equipment, including recognizable blindfold/towel/lenses/meat ring exceptions; real layering and hand choices. |
| `quaff` | Shipped | game.drink: potion or genuine fountain/sink confirmation. |
| `quit` | Shipped | Named game operation; success, time and decisions remain engine-owned. |
| `quiver` | Supported | Distinct game.fire/quiver/swap/twoWeapon controls; no autoquiver or fire-assist substitution. Explicit hands/slot/target choices. |
| `read` | Partial | Whole-inventory attempts permit engine exceptions; wand warning, marker second item/text, ritual and prior position/study fixtures tested. Not every object effect is covered. |
| `redraw` | Excluded | No inventory letters or terminal control; client presentation owns layout. |
| `remove` | Supported | game.equip/remove selects exact carried equipment, including recognizable blindfold/towel/lenses/meat ring exceptions; real layering and hand choices. |
| `repeat` | Excluded | One explicit operation at a time; no repeat/travel/prefix surface. |
| `reqmenu` | Excluded | One explicit operation at a time; no repeat/travel/prefix surface. |
| `retravel` | Excluded | One explicit operation at a time; no repeat/travel/prefix surface. |
| `ride` | Unsupported | No public named binding. See full audit for alternatives and their limits; pay is needed for paid shopping. |
| `rub` | Supported | Distinct named game operation, explicit engine items, text, targets and confirmations. See scenario matrix; subeffects are not exhaustively covered. |
| `run` | Excluded | One explicit operation at a time; no repeat/travel/prefix surface. |
| `rush` | Excluded | One explicit operation at a time; no repeat/travel/prefix surface. |
| `save` | Partial | session.close/resume use durable journals and pinned package; not engine save command. |
| `saveoptions` | Partial | Ground-pickup subset via game.configurePickup. Other general options and persistence commands are excluded. |
| `search` | Shipped | Named game operation; success, time and decisions remain engine-owned. |
| `seeall` | Partial | Public observation/actions cover only part of manual information; no complete view parity claim. |
| `seeamulet` | Partial | Public observation/actions cover only part of manual information; no complete view parity claim. |
| `seearmor` | Partial | Public observation/actions cover only part of manual information; no complete view parity claim. |
| `seerings` | Partial | Public observation/actions cover only part of manual information; no complete view parity claim. |
| `seetools` | Partial | Public observation/actions cover only part of manual information; no complete view parity claim. |
| `seeweapon` | Partial | Public observation/actions cover only part of manual information; no complete view parity claim. |
| `shell` | Excluded | No host/process/report/debug commands; source may be compile-conditional. |
| `showgold` | Partial | Public observation/actions cover only part of manual information; no complete view parity claim. |
| `showspells` | Partial | observation.knowledge.spells provides menu-level facts; spell ordering, letters and casting-mode configuration remain absent. |
| `showtrap` | Partial | Public observation/actions cover only part of manual information; no complete view parity claim. |
| `sit` | Unsupported | No public named binding. See full audit for alternatives and their limits; pay is needed for paid shopping. |
| `suspend` | Excluded | No host/process/report/debug commands; source may be compile-conditional. |
| `swap` | Supported | Distinct game.fire/quiver/swap/twoWeapon controls; no autoquiver or fire-assist substitution. Explicit hands/slot/target choices. |
| `takeoff` | Supported | game.equip/remove selects exact carried equipment, including recognizable blindfold/towel/lenses/meat ring exceptions; real layering and hand choices. |
| `takeoffall` | Unsupported | No public named binding. See full audit for alternatives and their limits; pay is needed for paid shopping. |
| `teleport` | Unsupported | No public named binding. See full audit for alternatives and their limits; pay is needed for paid shopping. |
| `terrain` | Partial | Public observation/actions cover only part of manual information; no complete view parity claim. |
| `therecmdmenu` | Partial | Public observation/actions cover only part of manual information; no complete view parity claim. |
| `throw` | Supported | game.throw selects an object and direction; normal engine multishot, no caller-selected volley count. |
| `tip` | Unsupported | No public named binding. See full audit for alternatives and their limits; pay is needed for paid shopping. |
| `toggle` | Partial | Ground-pickup subset via game.configurePickup. Other general options and persistence commands are excluded. |
| `travel` | Excluded | One explicit operation at a time; no repeat/travel/prefix surface. |
| `turn` | Unsupported | No public named binding. See full audit for alternatives and their limits; pay is needed for paid shopping. |
| `twoweapon` | Supported | Distinct game.fire/quiver/swap/twoWeapon controls; no autoquiver or fire-assist substitution. Explicit hands/slot/target choices. |
| `untrap` | Unsupported | No public named binding. See full audit for alternatives and their limits; pay is needed for paid shopping. |
| `up` | Shipped | game.climb with up/down direction. |
| `vanquished` | Partial | Public observation/actions cover only part of manual information; no complete view parity claim. |
| `version` | Excluded | Docs/discovery/pinned identity replace engine command-entry UI; no raw command string. |
| `versionshort` | Excluded | Docs/discovery/pinned identity replace engine command-entry UI; no raw command string. |
| `wait` | Shipped | Named game operation; success, time and decisions remain engine-owned. |
| `wear` | Supported | game.equip/remove selects exact carried equipment, including recognizable blindfold/towel/lenses/meat ring exceptions; real layering and hand choices. |
| `whatdoes` | Excluded | Docs/discovery/pinned identity replace engine command-entry UI; no raw command string. |
| `whatis` | Partial | Public observation/actions cover only part of manual information; no complete view parity claim. |
| `wield` | Supported | Explicit carried selection or engine hands option; counted selection when the standing item decision permits it. |
| `wipe` | Unsupported | No public named binding. See full audit for alternatives and their limits; pay is needed for paid shopping. |
| `zap` | Shipped | Named game operation; success, time and decisions remain engine-owned. |
| `movewest` | Shipped | game.move direction west, one adjacent step. |
| `movenorthwest` | Shipped | game.move direction northwest, one adjacent step. |
| `movenorth` | Shipped | game.move direction north, one adjacent step. |
| `movenortheast` | Shipped | game.move direction northeast, one adjacent step. |
| `moveeast` | Shipped | game.move direction east, one adjacent step. |
| `movesoutheast` | Shipped | game.move direction southeast, one adjacent step. |
| `movesouth` | Shipped | game.move direction south, one adjacent step. |
| `movesouthwest` | Shipped | game.move direction southwest, one adjacent step. |
| `rushwest` | Excluded | No automatic running/rushing or repeated moves. |
| `rushnorthwest` | Excluded | No automatic running/rushing or repeated moves. |
| `rushnorth` | Excluded | No automatic running/rushing or repeated moves. |
| `rushnortheast` | Excluded | No automatic running/rushing or repeated moves. |
| `rusheast` | Excluded | No automatic running/rushing or repeated moves. |
| `rushsoutheast` | Excluded | No automatic running/rushing or repeated moves. |
| `rushsouth` | Excluded | No automatic running/rushing or repeated moves. |
| `rushsouthwest` | Excluded | No automatic running/rushing or repeated moves. |
| `runwest` | Excluded | No automatic running/rushing or repeated moves. |
| `runnorthwest` | Excluded | No automatic running/rushing or repeated moves. |
| `runnorth` | Excluded | No automatic running/rushing or repeated moves. |
| `runnortheast` | Excluded | No automatic running/rushing or repeated moves. |
| `runeast` | Excluded | No automatic running/rushing or repeated moves. |
| `runsoutheast` | Excluded | No automatic running/rushing or repeated moves. |
| `runsouth` | Excluded | No automatic running/rushing or repeated moves. |
| `runsouthwest` | Excluded | No automatic running/rushing or repeated moves. |
