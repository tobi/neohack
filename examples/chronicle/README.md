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
90-second timeout, and errors do not trigger automatic paid retries. The gateway
path caps output at 2,200 tokens, including reasoning; the CLI path is limited to
one model step and validates the resulting story length afterward.
Repeating a command with the same output directory, evidence, model and prompt
reuses its validated story without calling the model. Changed evidence invalidates
the old output before generation, so a failed request cannot present an old story
as the new run. Replay reconstruction itself still runs to establish that evidence.

## What survives preprocessing

The collector retains the opening, apparent starting companions, actual ending,
witnessed messages, explicit life-saving events, large health reversals, condition
changes and level transitions. It scores unusual messages and recurring themes
such as traps, prayers and pets, with the preceding event for context. It drops
maps, coordinates, inventory dumps, opaque references, transport diagnostics,
private script notes, repeated observation queries and old receipts. This ranking
is editorial only: it never provides game strategy or interprets hidden state.
Narration comes from fresh `heard`/`passage` events; the rolling observation
message window is only initial context. Health changes become qualitative
reversals rather than a stream of HP numbers. A companion sighting establishes
presence at that incident, not a claim that it survived or followed later.

Memory stays bounded: at most 96 candidate entries plus three recent entries;
context holds one event, never a chain of the entire history. The final prompt
contains at most about 28 events and **16,000 UTF-8 evidence bytes**. Long runs can
omit minor episodes; the packet reports that omission. Evidence selection is not
a claim that every important event is guaranteed to survive compression.

Replay mode verifies the static manifest and immutable input chunk checksums,
then reconstructs **every** input in an isolated WASM worker. It deliberately
does not jump through checkpoints, which would skip the incidents being told.
It uses only the archive's exact runtime package, cached from neohack.dev with
verified hashes and retained license notices. `--runtime /path/to/dist/wasm` uses
an already downloaded matching package. A mismatched pin or corrupt recording
fails; there is no fresh-engine fallback. Only a chunk and current response are
held. Reconstruction can take time for a long run, but never blocks a live game.

Full-reply mode accepts public snapshots, `{request,response}` captures and MCP
`structuredContent`. It requires one run in chronological revision order. Raw
inputs and compact deltas are not observations: use replay mode or materialize
the full public replies first. Name/role can be supplied as display metadata.

## Prompt and cost

[prompt.mjs](prompt.mjs) is the versioned editorial contract. The model writes
3–6 connected scenes with affectionate understatement and an earned callback.
It must not turn a wounded leg into an amputation, healing into resurrection,
a missing pet into a death, or quit into death. Incomplete logs stay incomplete.
Every paragraph lists source event IDs. Structural checks reject unknown IDs,
a missing final-ending citation, invalid JSON and stories over 550 words.
These checks make review possible; they cannot prove every sentence true.
See [EVALUATION.md](EVALUATION.md) for the actual Muse prompt trials, including
remaining decorative embellishments. This is a labelled creative retelling, not
an authoritative replacement for the journal or a machine-verified factual summary.

Vercel lists Muse Spark 1.3 at $1.25 / million input tokens and $4.25 / million
output tokens as checked 2026-09-08. A 4,000-input / 1,000-output-token story is
about **$0.00925**, excluding any extra billed reasoning. Actual usage varies;
the gateway's returned usage is saved in `story.json`. Byte limits are not exact
token counts. The CLI caches by evidence, model and prompt; a future service
should share that cache and serve successful stories statically, never regenerate
them on page views. This tool does not add a website button or hosting endpoint.

Sources: [model and pricing](https://vercel.com/ai-gateway/models/muse-spark-1.3),
[gateway authentication](https://vercel.com/docs/ai-gateway/authentication-and-byok).

## Verification

```sh
node --test examples/chronicle/*.test.mjs
```

Tests include 100,000 noisy replies with early reversals and a terminal event,
query/receipt deduplication, mixed-run rejection, incomplete endings, safe HTML,
source citation checks, fresh versus rolling narration, paid-call cache/failure
handling, actual native decisions and a real WASM input archive
served statically. Model quality is evaluated separately; synthetic story cases
are labelled as such and do not claim those events occurred in NetHack.
