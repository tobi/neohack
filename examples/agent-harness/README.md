# Explicit agent harness

This maintained reference harness replaces the fragile helpers used in the
September 8 experiment. Historical logs and scripts remain evidence; these
modules do not edit or replay saved games. Two distinct consumers share the
public engine semantics without translating MCP frames back into low snapshots:

| Consumer | Contract and responsibility |
| --- | --- |
| `decision-client.mjs`, `run-pi.mjs` | MCP DecisionFrame v2, discovered high tools, explicit view IDs and the shared `SceneReader` |
| `client.mjs`, `harness.mjs`, `library-client.mjs` | Public low library snapshots and tagged answers, local durable reservations and an explicitly selected reference policy |

Neither consumer inspects hidden engine state or changes game rules. The policy
guards below belong to the library harness, not the MCP adapter or Pi tool bridge.

The caller chooses each action. Walking executes one bounded leg, and repeated
combat requires a separately bound target intent. There is no autonomous player,
automatic meal selection, warning acceptance, session creation, or retry loop.

## Run Pi with MCP tools only

From the repository root:

```sh
node examples/agent-harness/run-pi.mjs --minutes 60
```

This builds Bun/WASM MCP and the TypeScript reader, installs local dependencies,
creates one fresh game, and starts the installed Pi CLI with `vllm/current`.
Pi uses its existing model configuration (including the context limit).
Built-in tools, discovered extensions, skills, prompt templates and context
files are disabled; the explicitly loaded extension exposes only the supported
discovered MCP tools through `createDecisionClient`. No shell or filesystem tools are
available to the model. This is tool isolation, not an OS sandbox.

Use `--seed 217`, `--model vllm/current`, `--minutes 60`, or
`--output /absolute/new/directory` to choose the run. Default output is a new
`~/neohack-pi-...` directory. An existing output directory is rejected.
`--library` selects another source checkout. Building requires Bun, Node, the
native development prerequisites and Emscripten; see the library's
[build instructions](../../lib/neonethack/README.md). `build.log` retains failures.

The foreground command stops on Pi completion, terminal state, unresolved
execution or its deadline. Ctrl-C stops both Pi and MCP and preserves evidence.
It does not automatically restart a hero or resume an interrupted run.
`run.json` records session identity, Pi's actual active tools/context limit,
and stop reason. `mcp.jsonl`, `sessions/`, `pi.jsonl`, `pi.stderr.log`,
`pi-sessions/`, `tools.json` and `prompt.txt` retain calls, game saves,
conversation and the actual tool/prompt configuration. This runner does not
create the library harness's `client/` snapshot store.
The owner creates the run; Pi receives the discovered tools except `create`,
`resume`, `suspend` and diagnostic `receipt`. Item operations remain available
when discovered. Exact recovery after uncertain execution requires separate
inspection; the command never retries input automatically.

The MCP client holds a DecisionFrame through the shared `SceneReader`. Callers
supply the held `basis.viewId` on mutations or the exact question ID on
answer/cancel. It does not inject a fresh view, reconstruct low snapshots or add
an action–sync loop. `syncState` is a deliberate full-world/recovery query;
only explicit settled verification can clear uncertain execution. The runner
stops when input becomes unavailable rather than running a recovery policy.

## Install and inspect

Use Node 22.18 or newer from this repository checkout:

```sh
npm ci --prefix examples/agent-harness
npm test --prefix examples/agent-harness
node examples/agent-harness/inspect.mjs /path/to/public-state.json
```

The inspection command accepts a complete low library snapshot or the library
client's snapshot envelope, not an MCP DecisionFrame. It prints exact item references, equipment use, map layers,
and lifecycle state. It sends no game input. Exit codes are 0 for live, 20 for
terminal, 21 for disconnected/recovery needed, 22 for unknown, and 1 for invalid
input. A historical snapshot is evidence of that observation, not proof of a
currently running session. Unreconstructed deltas are rejected.

## Connect the library reference policy to an owned run

`client.mjs` accepts a sender returning raw low library replies. Explicitly
create or resume the run through a public `Neonethack` client before attaching
this policy, and keep exclusive ownership. `librarySender(api)` maps the policy's
named calls to low methods and uses the shared `Game` navigator for bounded legs.
Its request IDs derive from the durable local `context.reservationId`; preserve
the exact reservation-to-request mapping for any injected recovery provider.

```js
import {createSnapshotClient} from './client.mjs';
import {createAgentHarness} from './harness.mjs';
import {createOperationValidators} from './operations.mjs';
import {librarySender} from './library-client.mjs';

// Provided by the owner: api (Neonethack), runId, sessionId, runDir,
// records and an exact-receipt recovery provider recoverExact.
const client = createSnapshotClient({
  runDir, sessionId, send: librarySender(api), recoverExact,
});
const runner = createAgentHarness({
  runId, sessionId, client, records,
  operations: createOperationValidators({sessionId}),
});
await runner.observe({deliberate: true}); // low session.observe, not MCP syncState
const {state} = await runner.view();
await runner.dispatch({
  runId, sessionId, expectedRevision: state.revision,
  operation: 'wait', args: {}, approved: true,
});
```

`approved: true` records an explicit choice by the authorized policy or user; it
does not require a new human confirmation for every attempt. Real engine
decisions still require their exact current `decisionId` and explicit answer.
Supported low operation validators come from `protocol/catalog.ts`, with no default
argument injection, coercion, unknown-field fallback, or copied game schema.
The policy's bounded navigation schema is local to `operations.mjs`; its execution
uses the shared library navigator. `expectedRevision` in the dispatch example is
a local policy guard, not an MCP wire argument. Item selections use low
`item:{id}`, answers use tagged low values, and ordinary movement retains the
library's direction arguments. Do not substitute MCP target or answer syntax.

The snapshot client's default decoder accepts low version-1 replies and rejects
MCP frames or unreconstructed deltas. Keep original request/reply pairs for
`records()`; rolling narration cannot establish a fresh bump. This separate
library consumer is not a compatibility adapter for the
[MCP DecisionFrame contract](../../lib/neonethack/docs/PROTOCOL.md#mcp-observation-presentation).

[native-integration.test.mjs](native-integration.test.mjs) is an executable
example of MCP bridge initialization, a disposable Bun/WASM run, shared
`SceneReader`, explicit decision answers, stale-view rejection and no compensating
action–sync loop. It exercises `createDecisionClient`, not the library policy or
a production exact-receipt recovery provider.

## Stops and recovery

- Snapshot read, guard, reservation, send, and snapshot replacement use the same
  per-run client lock. All writers must use the same local `runDir`.
- Guards reject errors, wrong runs/revisions, uncertain coordinates, nearby eye
  appearances, and action-local eye bumps for melee-capable intents. Explicit
  `moveWithoutAttack` and ranged throws remain available as attempts.
  “Clear” means this limited policy found no signal; it is not a safety guarantee.
- Item actions require an exact currently returned reference and offered action.
  Labels, letters, corpse species, and glyphs do not establish identity, freshness,
  edibility, or safety. No food is automatically selected.
- `runner.walk({intent, to, maxActions})` retains its destination's original level
  under the stable intent key. Use a new key for a new destination or replan.
  Hunger, injury, condition changes, creatures, decisions and uncertainty stop
  the leg. A triage override names the exact initial facts and a reason; it does
  not override new changes. There is no automatic force fallback.
- `bindIntent` and `createIntentQueue`, followed by `runner.executeIntent`, support
  adjacent attack/kick/open/close one precise action at a time. The next response
  must still match the perceived target, goal, equipment and self-state. A kill,
  changed obstacle, intervening input or uncertain receipt stops the old intent.
- Terminal facts cancel registered play/poll jobs and prevent new mutation.
  Deliberate observation/export is retained. Disconnect is distinct from death.
- `runner.recover({deliberate: true})` delegates only to the configured exact
  recovery provider, then requires a current observation. It never resubmits a
  new action. Observation cannot clear an uncertain mutation. An explicit read
  can refresh a failed read-only observation without replaying gameplay.

The client stores durable pending reservations, monotonic snapshots and separate
receipts. Crash ownership is conservative: establish that the old owner stopped
before removing a leftover `.client-owner` directory. Preserve pending state and
receipts. Session/runtime resumption is intentionally outside this sample; never
resume on a different engine package. A bridge timeout closes admission and
retains late replies; the owner must arrange exact recovery or stop.

Always await `bridge.close()` before exiting. POSIX process-group cleanup does
not cover descendants that deliberately leave the group; other platforms need
an appropriate injected process supervisor. This is a local filesystem example,
not a cloud persistence or multi-host locking implementation.

## Verification

The portable suite uses disposable public-shape fixtures and subprocesses. To
include the real Bun/WASM MCP test, build the library and run:

```sh
npm ci --prefix lib/neonethack
make -C lib/neonethack wasm
npm run --prefix lib/neonethack build
NEONETHACK_MCP_TEST_ROOT="$PWD/lib/neonethack" npm test --prefix examples/agent-harness
```

Optional `NEO42_ARCHIVE` and `NEO43_REPLAY_ROOT` enable hash-verified, read-only
checks against the September 8 public MCP logs. Missing optional archives are
not native or WASM coverage. Engine held-state and MCP terminal-summary changes
have their own real native, WASM and browser regressions under the library tests.

The twelve focused modules correspond to audit tasks 42–53. The composed
`harness.mjs`, shared-catalog `operations.mjs`, read-only `inspect.mjs` and their
integration tests ensure those fixes operate together. The BB Pi context-clear
fix belongs to its separate BB repository, not this harness.

## Discovery usability check

`node examples/agent-harness/discovery-check.mjs --out /tmp/mcp-discovery` runs
an opt-in, bounded fresh Pi model exercise against a disposable local Bun/WASM MCP.
It needs the built engine and a configured Pi (`vllm/current` by default). The model receives
only a plain-language task, live discovery and returned replies; no tool-name
cheat sheet or argument repair. At most nine tool calls and two minutes, no automatic retries,
and no production traffic. Raw evidence remains private in the selected output
directory; `summary.json` records sanitized results and limitations. This is a
usability sample, separate from fixed policy/seed gameplay benchmarks.

The September 8 check using `vllm/current` passed with six calls: create,
observe (now named `syncState`), inspect, pray, answer(false), suspend. Observe
and inspect were concurrent free reads. All 54 live schemas were available; the host supplied
no argument corrections. Native/WASM contract tests separately cover all six
question kinds. One model sample does not establish a general success rate.
