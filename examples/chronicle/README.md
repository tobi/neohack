# A dungeon chronicle

Turn a run into a funny, one-page epic with **Muse Spark 1.3**. This is an
on-demand tool, outside the game loop. It neither changes recording nor adds an
AI call to walking, saving or watching a replay.

```sh
# An exact static input manifest from a replay/embed link:
node examples/chronicle/cli.mjs --replay 'https://YOUR-PUBLIC-BLOB/replays/RUN/manifest-HASH.json' --out /tmp/my-chronicle

# Or a captured sequence of full public protocol replies, one JSON object per line:
node examples/chronicle/cli.mjs --input /tmp/replies.jsonl --name Edda --role valkyrie --out /tmp/my-chronicle

# Inspect the reduced evidence/prompt without making any model request:
node examples/chronicle/cli.mjs --input /tmp/replies.jsonl --prepare-only
```

Open `index.html`. The page prints cleanly and includes an expandable evidence
list and paragraph-to-event references. `digest.json`, `prompt.txt`, the actual
`model-output.txt` and `story.json` remain alongside it for review. Output defaults
to `/tmp/neohack-chronicle`; keep personal recordings and stories out of Git.

The default provider uses an already authenticated `muse` CLI with
`muse-spark-1.3`, minimal reasoning, one model step, and no shell, file-write or
web tools. It does not load the project's instructions or personal context.
`--provider gateway` instead uses Vercel AI Gateway's `meta/muse-spark-1.3` with
`AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN` supplied through the environment.
No credential goes into the evidence, prompt or browser page. Requests have a
90-second CLI timeout or a 180-second gateway timeout, and errors do not trigger
automatic paid retries. The gateway path caps output at 2,400 tokens, including
reasoning; the CLI path is limited to
one model step and validates the resulting story length afterward.
Repeating a command with the same output directory, evidence, model and prompt
reuses its validated story without calling the model. Changed evidence invalidates
the old output before generation, so a failed request cannot present an old story
as the new run. Replay reconstruction itself still runs to establish that evidence.

## What survives preprocessing

The collector keeps nearly everything the hero witnessed. Every reply that
carried a message, a vitals reversal, a place or level change, a notable action
(prayer, eating, quaffing, reading…), a life-saving event or the ending becomes
one **turn line** of a markdown journal; moves that reported nothing are left
out, and identical consecutive routine lines ("You hit the jackal.") are counted
once with a repeat count instead of retold. It drops maps, coordinates, inventory
dumps, opaque references, transport diagnostics, private script notes, repeated
observation queries and old receipts. This ranking is editorial only: it never
provides game strategy or interprets hidden state. Narration comes from fresh
`heard`/`passage` events; the rolling observation message window is only initial
context. Health changes become qualitative reversals rather than a stream of HP
numbers. A companion sighting establishes presence at that incident, not a claim
that it survived or followed later.

Lines are cited by turn: `T340` is the event at turn 340 and `T340.2` a second
event within that turn, so the story's citations read as coordinates in the
journal rather than opaque IDs. The journal is plain markdown:

```
T295 Dlvl:2 · apply — You slip the leash around your little dog.
T296 Dlvl:2 — A tower of flame erupts from the floor under the little dog! The little dog is killed!
T383 Dlvl:3 · HP lost, critically low · ENDING death — killed by a hill orc (score 362)
```

Memory stays bounded for endless transcripts (at most 16,000 retained entries,
trimmed by score; no linked history chain). The rendered journal is capped at
**245,000 characters, roughly 70,000 input tokens**; a run that exceeds it drops
its lowest-scored lines and says so in the coverage note. A typical short run
(400 replies) is about 14 KB / 3,500 tokens; an 8,300-reply run about 225 KB /
60,000 tokens.

Replay mode verifies the static manifest and immutable input chunk checksums,
then reconstructs **every** input in an isolated WASM worker. It deliberately
does not jump through checkpoints, which would skip the incidents being told.
It uses the archive's exact compiled core, engine and data, cached from neohack.dev
with verified hashes and retained license notices. Current host workers process
128 inputs per batch, verifying each full receipt and available RNG boundary
before returning compact narration evidence. Maps and inventory never cross
back to the collector. Selection and the resulting model prompt remain the same
as collecting full replies individually. `--runtime /path/to/dist/wasm` uses
an already downloaded matching package. A mismatched pin or corrupt recording
fails; there is no fresh-engine fallback. Memory holds a bounded prefetch window,
the current decoded chunk and at most 128 compact evidence records. The worker
does not retain a second input-history copy. Reconstruction never blocks a live game.

Full-reply mode accepts public snapshots, `{request,response}` captures and MCP
`structuredContent`. It requires one run in chronological revision order. Raw
inputs and compact deltas are not observations: use replay mode or materialize
the full public replies first. Name/role can be supplied as display metadata.

## Prompt and cost

[prompt.mjs](prompt.mjs) is the versioned editorial contract. The model writes
4–6 connected paragraphs with affectionate understatement and an earned callback.
It must not turn a wounded leg into an amputation, healing into resurrection,
a missing pet into a death, or quit into death. Incomplete logs stay incomplete.
The story comes back as markdown (`# Title`, then paragraphs, each ending in
its turn citations such as `[T12, T340]`), which is why it can be streamed to a
reader word by word; the citations are parsed out of the prose afterwards.
Structural checks reject unknown turn ids, a missing final-ending citation,
malformed output and stories over 650 words. These checks make review possible;
they cannot prove every sentence true. See [EVALUATION.md](EVALUATION.md) for
the actual Muse prompt trials, including remaining decorative embellishments.
This is a labelled creative retelling, not an authoritative replacement for the
journal or a machine-verified factual summary.

Vercel lists Muse Spark 1.3 at $1.25 / million input tokens and $4.25 / million
output tokens as checked 2026-09-08. The evidence budget is deliberately
generous because the model is cheap: a full 70,000-token journal plus a
1,000-token story is about **$0.09**, a typical short run under a cent. Actual
usage varies; the gateway's returned usage is saved in `story.json`. Character
limits are not exact token counts. The CLI caches by evidence, model and prompt.

Where the time goes: the public archive stores **inputs only**, so the messages
must be reconstructed by the pinned engine and semantic core. Compacted chunks
are fetched ahead; uncached runtime assets download six at a time with every
checksum checked. A 2026-09-10 local comparison on one published 4,364-input run
measured about 24.8 seconds before and 19.8 seconds with evidence batching, with
an identical model-input hash. This is one original-pin comparison, not a general
speed guarantee. A CPU profile still attributed most replay work to the pinned
semantic core; batching does not skip that work or upgrade the run's binary.
Model latency is separate and its answer continues to stream as it is written.

`collectReplay(..., {onTiming})` reports manifest/setup, time waiting for decoded
inputs, verified replay, digest, lore and teardown, plus input/chunk/batch counts.
Download-wait time includes decoding and only the wait visible after prefetch;
it is not the sum of network request durations. Hosting logs these alongside
admission, publication, model first-text/completion, validation and storage time.
The operational log contains counts and durations, never journal text or URLs.

The website shares this code: `hosting/vercel/src/chronicle.ts` stages
`digest.mjs`, `prompt.mjs`, `lore.mjs`, `generate.mjs` and `replay.mjs` into
its function, generates a story once per eligible run (dungeon level 3,
experience level 2, ended in death), streams progress and the story to the
reader, caches it as a public object and serves it statically from the death
screen, the ledger and the replay page. See the hosting README.

## Encyclopedia notes

[lore.mjs](lore.mjs) turns names the witnessed messages actually mention
(monsters, items, gods, roles, dungeon features) into dotted lookups. Candidate
noun phrases come only from the evidence, are resolved with the pinned engine's
own `session.lookup` encyclopedia, and only names that then appear in the story
are annotated. Words the model introduced on its own are never linked, so a
dotted term is reference lore for something the log mentioned, not an inferred
identity. The HTML page lists the entries below the story; the website opens them
inline.

Sources: [model and pricing](https://vercel.com/ai-gateway/models/muse-spark-1.3),
[gateway authentication](https://vercel.com/docs/ai-gateway/authentication-and-byok).

## Verification

```sh
node --test examples/chronicle/*.test.mjs
```

No test makes a model request. Every chronicle test (and the website's test
harness) imports [no-model-calls.mjs](no-model-calls.mjs), which strips
`AI_GATEWAY_API_KEY`/`VERCEL_OIDC_TOKEN` from the process and makes any fetch to
the AI Gateway host throw; the CLI test runs a fake `muse` executable, the
gateway path is exercised with an injected fetch double, and the website tests
inject a story model. Tests include 100,000 noisy replies with early reversals and a terminal event,
query/receipt deduplication, mixed-run rejection, incomplete endings, safe HTML,
source citation checks, fresh versus rolling narration, paid-call cache/failure
handling, actual native decisions, encyclopedia term selection and a real WASM
input archive served statically. Model quality is evaluated separately; synthetic story cases
are labelled as such and do not claim those events occurred in NetHack.
