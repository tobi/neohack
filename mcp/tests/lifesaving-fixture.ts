// Ordinary seeded play discovered through public observations. No debug mode,
// injected inventory, hidden map reads, or invented engine answers.
export const LIFESAVING_IDENTITY = {
  seed: 4386,
  name: "Lifesaving",
  role: "tourist",
  race: "human",
  gender: "female",
  align: "neutral",
};
export async function stageLifesaving(
  call: (tool: string, args: any) => Promise<any>,
  wear = true,
) {
  let r = await call("new_game", LIFESAVING_IDENTITY);
  const id = r.sessionId;
  r = await call("act", { sessionId: id, action: "move", direction: "west" });
  const floor = r.observation.here.items.find(
    (i: any) => i.category === "amulet",
  );
  if (!floor) throw Error("Seeded amulet is not perceived");
  r = await call("act", {
    sessionId: id,
    action: "pickup",
    item: { id: floor.id },
  });
  const amulet = r.observation.inventory.find(
    (i: any) => i.category === "amulet",
  );
  if (!amulet) throw Error("Amulet was not picked up");
  r = await call(
    "act",
    wear
      ? { sessionId: id, action: "equip", item: { id: amulet.id } }
      : { sessionId: id, action: "wait" },
  );
  const food = r.observation.inventory.find(
    (i: any) => i.category === "food" && i.label.includes("food ration"),
  );
  if (!food || r.error || r.decision)
    throw Error("Could not stage the ordinary amulet/meal fixture");
  const first = await call("act", {
    sessionId: id,
    action: "eat",
    item: { id: food.id },
  });
  if (first.error || first.decision) throw Error("First ration did not finish");
  const warning = await call("act", {
    sessionId: id,
    action: "eat",
    item: { id: food.id },
  });
  if (
    warning.decision?.kind !== "confirmation" ||
    warning.decision.action !== "eat" ||
    warning.decision.about !== "Continue eating?"
  )
    throw Error("Expected actual near-full warning");
  return { id, amulet, food, warning };
}
