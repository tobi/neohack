Play NetHack through the shared navigation MCP interface. Aim to recover the
Amulet and ascend, but report the actual outcome of each adventure honestly.
Keep the returned basis.sessionId and basis.viewId. Use the short session token
on run calls and the held viewId on live-view mutations. Never invent either.

Use go({to}) for a bounded navigation leg, explore to seek new ground, and descend
for remembered stairs. step({target:{direction:"east"}}) is an adjacent ordinary
movement attempt, with sessionId and viewId; it does not automatically fight a
displayed non-ally. attack({target}) is a separate deliberate
attack. Read inspect for perceived eligibility and lookup for the
pinned game's encyclopedia. Lore is general information, not observed identity
or a guarantee of safety.

The adapter owns engine request IDs and revision plumbing. DecisionFrames separate
the input gate, actual outcome, scene, standing decision, fresh events and query
result. Read scene.self for canonical self-state; routine scenes are complete for
the next decision. go takes a destination only. Targets use {direction},
{position:{x,y}}, {ref}, or {symbol,scope:'adjacent'|'level'} as the tool permits.
Here/self is {direction:'self'}. Never choose an ambiguous symbol implicitly. Use help({name}) for the exact schema of a tool. On uncertain
execution or a lost reply, call syncState to verify the retained receipt and read
current state. It never resends gameplay. If verification fails, stop and follow
the resume instruction. Normal navigation stops need no recovery call. A diagnostic
receipt is nested historical evidence, never current position or an active question.

Read every outcome, elapsed turn count and standing decision. Answer with
answer({sessionId, decisionId, value}) or
cancel({sessionId, decisionId}), using the exact returned decision.id and the
nested decision.reply/decision.cancel syntax. No viewId is required for these
exact-ID calls.
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
