# Explicit agent harness

This maintained reference harness replaces the fragile helpers used in the
September 8 experiment. Historical logs and scripts remain evidence; these
modules do not edit or replay saved games. They compose around the public MCP
contract and never inspect hidden engine state or change game rules.

The caller chooses each action. Walking executes one bounded leg, and repeated
combat requires a separately bound target intent. There is no autonomous player,
automatic meal selection, warning acceptance, session creation, or retry loop.

## Run Pi with MCP tools only

From the repository root:

```sh
node examples/agent-harness/run-pi.mjs --minutes 60
```

This builds native MCP and the TypeScript reader, installs local dependencies,
creates one fresh game, and starts the installed Pi CLI with `vllm/current`.
Pi uses its existing model configuration (including the context limit).
Built-in tools, discovered extensions, skills, prompt templates and context
files are disabled; the explicitly loaded extension exposes only the supported
MCP queries and guarded harness actions. No bash, read, edit or write tools are
available to the model. This is tool isolation, not an OS sandbox.

Use `--seed 217`, `--model vllm/current`, `--minutes 60`, or
`--output /absolute/new/directory` to choose the run. Default output is a new
`~/neohack-pi-...` directory. An existing output directory is rejected.
`--library` selects another built source checkout. Build prerequisites are the
same as native library development; `build.log` retains failures.

The foreground command stops on Pi completion, terminal state, unresolved
execution or its deadline. Ctrl-C stops both Pi and MCP and preserves evidence.
It does not automatically restart a hero or resume an interrupted run.
`run.json` records session identity, Pi's actual active tools/context limit,
and stop reason. `mcp.jsonl`, `client/`, `sessions/`, `pi.jsonl`, and
`pi-sessions/` retain requests, receipts, snapshots, game saves and conversation.
The binding exposes the harness's explicitly supported action subset; excluded
operations (including session lifecycle and unsupported inventory actions) are
not advertised. Exact recovery after uncertain execution requires separate
inspection; the command never retries input automatically.

## Install and inspect

Use Node 22.18 or newer from this repository checkout:

```sh
npm ci --prefix examples/agent-harness
npm test --prefix examples/agent-harness
node examples/agent-harness/inspect.mjs /path/to/public-state.json
```

The inspection command accepts a complete public snapshot or this client's
snapshot envelope. It prints exact item references, equipment use, map layers,
and lifecycle state. It sends no game input. Exit codes are 0 for live, 20 for
terminal, 21 for disconnected/recovery needed, 22 for unknown, and 1 for invalid
input. A historical snapshot is evidence of that observation, not proof of a
currently running session. Unreconstructed deltas are rejected.

## Connect an explicitly owned run

`client.mjs` accepts an injected MCP transport. `send(call, context)` must bind
the local `context.reservationId` to its durable original request. The bridge's
`rpc(request, {reservationId})` supports that correlation without adding fields
to the MCP wire protocol. Initialize the MCP connection and explicitly create
or resume a run before attaching this policy. Keep exclusive ownership of it.

```js
import {createSnapshotClient} from './client.mjs';
import {createAgentHarness} from './harness.mjs';
import {createOperationValidators} from './operations.mjs';

// Provided by your existing, exclusively owned MCP connection:
// runId, sessionId, runDir, send, decodeReply, records, recoverExact.
const client = createSnapshotClient({
  runDir, sessionId, send, decodeReply, recoverExact,
});
const runner = createAgentHarness({
  runId, sessionId, client, records,
  operations: createOperationValidators({sessionId}),
});
await runner.observe({deliberate: true});
const {state} = await runner.view();
await runner.dispatch({
  runId, sessionId, expectedRevision: state.revision,
  operation: 'game_wait', args: {}, approved: true,
});
```

`approved: true` records an explicit choice by the authorized policy or user; it
does not require a new human confirmation for every attempt. Real engine
decisions still require their exact current `decisionId` and explicit answer.
Supported operation validators come from `protocol/agent.ts`, with no default
argument injection, coercion, unknown-field fallback, or copied game schema.

Use the shared library's `CompactObservationReader` in `decodeReply` if the
transport returns compact deltas. One reader belongs to one connection. Retain
original request/reply pairs for `records()`; observation.heard is a rolling
buffer and cannot establish a fresh bump. The default client decoder unwraps
complete replies and rejects unreconstructed deltas.

[native-integration.test.mjs](native-integration.test.mjs) is an executable
example of bridge initialization, a disposable native run, the shared compact
reader, guarded dispatch, and exact receipt recovery. Its in-memory reservation
lookup is a test fixture; a production transport must recover the mapping from
the durable reservation-linked journal after a process restart.

## Stops and recovery

- Snapshot read, guard, reservation, send, and snapshot replacement use the same
  per-run client lock. All writers must use the same local `runDir`.
- Guards reject errors, wrong runs/revisions, uncertain coordinates, nearby eye
  appearances, and action-local eye bumps for melee-capable intents. Explicit
  `game_moveWithoutAttack` and ranged throws remain available as attempts.
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
include the real native MCP test, build the library and run:

```sh
make -C lib/neonethack
npm ci --prefix lib/neonethack
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
