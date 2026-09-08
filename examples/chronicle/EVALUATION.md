# Chronicle prompt evaluation · 2026-09-08

The selected prompt is `chronicle-v6` in `prompt.mjs`, using Muse Spark 1.3
with minimal reasoning. These were actual model calls through an authenticated
Muse CLI, not mocked story responses. The Vercel gateway integration was not
called with a live gateway credential; its usage/cost estimate is not a measured
bill for the CLI trials.

## Cases and results

| Case | Evidence | Final draft review |
| --- | --- | --- |
| The user's proposed absurd journey | **Synthetic**, six witnessed boundaries: enter with kitten; axe takes arm; bear trap takes leg; prayer; god restores both; kitten explodes and kills hero. Not a claim these events occurred in the pinned engine. | Preserved injuries, restoration and explosive ending in order, with an earned return to the kitten. Four short paragraphs. |
| Counterexample | **Synthetic**: wounded leg; prayer and health recovery; distant noises; explicit quit. The kitten is mentioned only at entry. | Did not invent amputation, limb regrowth, pet explosion/death or hero death. Preserved quit. Did not carry the kitten into the final scene. |
| Actual native run | Fresh temporary seed 9, lawful human female Valkyrie: creation, prayer request, exact-context cancellation, quit request and explicit confirmation. Five public replies, final turn 1. | Described considering and declining prayer, then ending the attempt. Did not replace quit with death or claim a completed divine rescue. |

All three final responses passed JSON shape, word-limit and source-ID checks.
This is a small manual quality evaluation, not a statistical hallucination rate.
Muse still added incidental details in some drafts, such as provisions in the
counterexample and inferred absence of combat in the native story. Those details
are not independently established by the reduced evidence. The output is labelled
AI writing and exposes its source packet; do not treat citation validation as a
factual verifier or automatically publish it as an exact account.

## What changed during the trials

Early prompts produced readable jokes but invented torches, exact footsteps,
an entrance staircase and a kitten witnessing later scenes. Subsequent versions
removed ordinary movement bookkeeping and raw HP values from the packet, made
companion sightings local to their event, and explicitly distinguished requests,
actual actions, cancellation, quit and death. The final version also forbids
absence claims from omissions and warns against treating absolute turn labels
as elapsed time.

Actual native evidence revealed that `observation.heard` is a rolling message
window. Feeding it on every reply repeated the introduction as though it were
a new prayer effect. The collector now uses fresh `heard`/`passage` events, with
the rolling window used only for first-snapshot context. Regression tests retain
a genuinely repeated new heard event while suppressing old window contents.

Two intermediate CLI requests exited with provider failures. One separate
provider diagnostic completed successfully afterward. The CLI does not
transparently retry failed requests; the evidence and prompt are retained.
All three final-version requests completed successfully.

## Reproduce without paid calls

```sh
node --test examples/chronicle/*.test.mjs
```

Eight tests cover bounded selection through 100,000 noisy replies; early and
late incidents; rolling narration; repeated new events; quit and incomplete
endings; mixed-run rejection; source references and HTML escaping; actual native
decisions; real static WASM reconstruction and corruption; and CLI cache/failure
handling. Only the provider in the cache test is a fake executable. The native
and WASM scenarios run actual games through the public protocol.

Use `--prepare-only` to inspect a packet and the current prompt for another run.
Paid model evaluation is deliberately outside CI. Keep source journals and
capability URLs private; output directories belong outside the repository.
