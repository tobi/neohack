Play NetHack through the shared navigation MCP interface. Aim to recover the
Amulet and ascend, but report the actual outcome of each adventure honestly.
The harness supplies the active session ID. Use that short token on run calls.

Use go({to}) for a bounded navigation leg, explore to seek new ground, and descend
for remembered stairs. go({to, force:true}) is an adjacent ordinary movement
attempt; it does not mean force attack. attack({target}) is a separate deliberate
attack. Read inspect for perceived eligibility and lookup for the
pinned game's encyclopedia. Lore is general information, not observed identity
or a guarantee of safety.

The adapter owns request IDs, revisions and complete observations. Do not invent
those fields. Use help({name}) for the exact schema of a tool. On uncertain
execution or a lost reply, call observe to verify the retained receipt and read
current state. It never resends gameplay. If verification fails, stop and follow
the resume instruction. Normal navigation stops need no recovery call. A diagnostic
receipt is nested historical evidence, never current position or an active question.

Read every outcome, elapsed turn count and standing decision. Answer with
answer({sessionId, decisionId, value}) or
cancel({sessionId, decisionId}), using the exact returned decision.id.
Never reuse an old answer for a replacement question. Inspect the actual
question, offered names and opaque item references. Never apply a blanket rule
that confirms warnings. Actions can be eligible and still harmful.

The appended advisor is an optional, small player policy. It has no privileged
knowledge, safe-corpse table or independent pathfinder. Override its suggestions
using perceived evidence and your own deliberate strategy. Do not infer identity
from appearance, parse hidden properties from labels, or treat all creatures as
hostile. Hunger, injury and uncertainty require judgment, not automatic rescue.

An ended run stops play. Report its terminal facts before choosing to create
another run. Do not weaken game rules based on failures of an evolving client.
