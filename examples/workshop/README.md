# Workshop scripts in Node

Run the same JavaScript projects offered by the [web workshop](../../web/neohack.dev/bots). The runner uses the real native NetHack engine and the existing `defineBot`, `Game`, and `Hero` APIs. It does not rewrite the script or simulate game outcomes.

From the repository root, with Node 22.18+ and the native build prerequisites installed:

```sh
npm ci --prefix lib/neonethack
npm run --prefix lib/neonethack build
make -C lib/neonethack engine native

node examples/workshop/run.js --list
node examples/workshop/run.js curious-imp --seed 42
node examples/workshop/run.js steady-fighter --seed 7 --calls 500 --json
```

Each run starts a fresh human Valkyrie with a fixed seed (42 by default). The browser defaults to a random class and seed; select Valkyrie and the matching fixed seed there to compare. Reproduction requires matching engine/data builds as well as identity and seed. Native and WASM execute the same engine contract; these are not cross-runtime replay receipts.

| Example | Plan |
| --- | --- |
| `curious-imp` | Follow new routes and stairs, open doors, eat identified rations, and retreat from nearby enemies. |
| `cartographer` | Explore the starting level without descending, revisit unfinished paths, and search near unknown terrain. |
| `steady-fighter` | Descend and fight single adjacent enemies while healthy; retreat when hurt or surrounded. |
| `first-steps` | Search once and stop: a small introduction to events. |

The main scripts are short. `explore.js` holds map routing, limited searches and unsuccessful-step handling; `care.js` holds ration selection and decision handling. These are editable **example policies**, not automatic behavior in the SDK. Opening a door can succeed without moving the hero. A failed edge is remembered so the explorer can try another route. Boulders are left for a strategy that knows how to push them.

Examples can stop when cornered or when they need another strategy; the fighter can die. They do not solve NetHack. In fresh native human-Valkyrie runs with a 500-call cap:

| Script | Seed 1 | Seed 7 | Seed 42 |
| --- | --- | --- | --- |
| Curious imp | 43 moves, depth 1, stopped | 90 moves, depth 3, stopped | 75 moves, depth 2, stopped |
| Cartographer | 43 moves, depth 1, stopped | 222 moves, depth 1, stopped | 41 moves, depth 1, stopped |
| Steady fighter | 401 moves, depth 7, died | 148 moves, depth 5, stopped | 196 moves, depth 3, died |

These are measured examples, not performance guarantees. `--json` reports actual engine turns, move receipts, unique visited/known squares, the deepest disclosed level, final outcome/decision/end, and the last 100 script logs. `--calls` counts every forwarded script API request, including free queries; it does not mean engine turns. Session creation is owned by the host and is not included in this count.

## Test your own project

Pass a directory containing `main.js` and its adjacent `.js` helpers, `main.js` itself, or the source JSON downloaded from an account run. The same workshop limits apply: up to 20 flat JavaScript files and 100 KB of source. Built-in IDs and their repository paths load all helpers from the shared catalog.

```sh
node examples/workshop/run.js ./my-script --seed 7 --calls 300
node examples/workshop/run.js ./source.json --trace /tmp/my-run.jsonl --json
```

`--trace` creates a new JSONL file containing the initial public snapshot and each full request/response. It refuses to overwrite an existing file. This is diagnostic output, not a resumable save or an authoritative replay journal.

`--timeout 30000` limits script execution time in milliseconds. The script runs in a child process so a busy loop, including one during module loading, can be terminated. Ctrl-C stops it too. The host finishes any already-submitted operation before cleaning up its temporary engine store. It never retries an uncertain request. Exit codes: 0 for normal stops, game end, or the call cap; 1 for errors/uncertainty; 2 for timeout/interruption.

**Run trusted local code.** The Node child has normal Node filesystem/network access. It is not the browser's security sandbox. Scripts use the supplied game; the broker rejects a second session and concurrent requests. Buttons/checkboxes are reported in the summary; this batch runner does not interact with them. Temporary sessions are removed after the run. Saving in the browser still creates a private account copy and its own script URL; running locally does not upload or modify that copy.

## Use from tests

```js
import assert from "node:assert/strict";
import { runProject } from "./examples/workshop/runtime.js";

const result = await runProject("curious-imp", {
  seed: 7,
  calls: 500,
  timeout: 30_000,
});
assert.ok(result.moves > 10);
assert.equal(result.error, undefined);
```

`runProject` also accepts `{name, files: {"main.js": "..."}}`. Options include `signal`, `log`, native `executable`, `enginePath`, `dataPath`, and an `identity` override (race/gender/alignment/role). Seed and name are supplied by the runner. `NEONETHACK_EXECUTABLE` can select another native bridge.

```sh
npm test --prefix examples/workshop
node --test web/neohack.dev/tests/imp.test.mjs
```

The tests exercise real engine operations, imports and tool parity, limits, abort/exception cleanup, session ownership, door opening, and the examples' differing exploration policies. The browser build and this runner both load [one example catalog](../../web/neohack.dev/bots/examples.json), so the tested sources are the files users receive when they choose an example.
