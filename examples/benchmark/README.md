# Fixed public-API exploration benchmark

Build the library and WASM runtime, then run from the repository root:

```sh
node examples/benchmark/run.mjs navigator > navigator.jsonl
node examples/benchmark/run.mjs world-only > world-only.jsonl
```

Both profiles use seeds 7, 42 and 123, a fixed UTC creation calendar, the same
explicit character identity, and a 200-leg budget. Every run starts in a fresh
volatile WASM store. The output records the actual runtime build ID, policy hash,
calendar, calls by low-level method, elapsed turns, downward level transitions,
visited locations, canonical perceived depths, terminal facts and stop reason. `tokens: null` means no model
was called, not that a model played for zero tokens. Depth comes from the engine-provided remembered level records, never parsing a
display string or an opaque level ID. Missing depth remains null.

The navigator policy uses the shared C queries and bounded navigation executor.
The world-only policy cannot call route/navigation: it chooses the least-visited
adjacent walking offer supplied by C. These are two declared reference policies,
not identical strategies with a hidden toggle. Neither contains a terrain table,
corner-rule implementation, corpse-safety regex or hidden-state lookup. They stop
on standing decisions and do not automatically confirm warnings, fight, eat or
rescue a failed route. A `noRoute` or budget stop is not a death.

Seed 7 currently demonstrates one downward transition with the navigator. This
is an API-access regression, not proof of expert play or ascension. The adaptive
CLI model/retro loop is a separate experiment; its evolving prompts are not
comparable fixed benchmark submissions. Model-driven evaluation and measured model-token accounting are separate from
this deterministic reference benchmark.

## Compare fixed submissions

```sh
node examples/benchmark/leaderboard.mjs navigator.jsonl world-only.jsonl > standings.json
```

Each input must contain exactly the fixed seeds 7, 42 and 123 under one runtime,
profile, calendar, identity, leg budget and policy hash. Missing/duplicate seeds,
mixed builds, invalid metrics and navigation calls in world-only results are
rejected. Different runtime/profile conditions produce separate cohorts, never
one pooled ranking. Policy hashes distinguish source revisions within a cohort.

Entries rank by mean perceived depth, then fewer deaths; turns and API calls are
reported separately. This is a declared exploration score, not a general skill
measure or an ascension claim. Raw per-seed stops and terminal facts remain in
the output. The tool validates local submissions; it does not authenticate
self-reported results or publish them. It rejects model token values because
these fixed reference programs do not call a model. Adaptive prompt training
results must not be inserted as if they used this fixed policy.
