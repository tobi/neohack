/** Private archive output, not a gameplay snapshot. Called only AFTER the full
 * receipt and available RNG witnesses have been verified by replayRecord.
 * Keep narration and self-state; omit maps, inventories and transport payloads.
 * Editorial selection stays in the chronicle collector. */
export function replayEvidence(response, index) {
  const o = response.observation;
  if (!o) {
    if (!response.error)
      throw Error("Archived input has no public reply or rejection");
    return { index, rejected: true };
  }
  if (!Array.isArray(o.heard) || !Array.isArray(response.events))
    throw Error("Archived input has an incomplete public reply");
  return {
    index,
    sessionId: response.sessionId,
    revision: response.revision,
    ended: response.ended,
    end: response.end,
    outcome: response.outcome,
    events: response.events.filter((e) =>
      ["heard", "passage", "lifeSaved"].includes(e.type),
    ),
    observation: {
      turn: o.turn,
      heard: o.heard,
      vitals: o.vitals,
      location: { depthLabel: o.location?.depthLabel },
      companions:
        index === 0
          ? (o.world ?? [])
              .filter((c) => c.occupant?.kind === "ally")
              .map((c) => c.occupant.appearance)
          : [],
    },
  };
}
