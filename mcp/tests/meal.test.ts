import { expect, test } from "bun:test";
import { TestBridge, testDirectory } from "./bridge-harness";

test("a real multi-turn meal pauses with current inventory and stops at the declined warning", async () => {
  const b = new TestBridge(testDirectory("meal"));
  try {
    const g = await b.call("new_game", {
        seed: 42,
        name: "Meals",
        role: "tourist",
        race: "human",
        gender: "female",
        align: "neutral",
      }),
      sid = g.sessionId;
    const ration = g.observation.inventory.find((i: any) =>
      i.label.includes("food ration"),
    );
    expect(ration.quantity).toBeGreaterThan(2);
    const first = await b.call("act", {
      sessionId: sid,
      action: "eat",
      item: { id: ration.id },
    });
    expect(first.outcome.status).toBe("completed");
    expect(first.outcome.turnsElapsed).toBe(6);
    expect(first.outcome.effects).toContain("consumedItem");
    const count = first.observation.inventory.find(
      (i: any) => i.id === ration.id,
    ).quantity;
    const warning = await b.call("act", {
      sessionId: sid,
      action: "eat",
      item: { id: ration.id },
    });
    expect(warning.outcome.status).toBe("needsChoice");
    expect(warning.decision.kind).toBe("confirmation");
    expect(
      warning.observation.inventory.find((i: any) => i.id === ration.id)
        .quantity,
    ).toBe(count - 1);
    expect(
      warning.observation.inventory.some((i: any) =>
        i.label.includes("partly eaten food ration"),
      ),
    ).toBe(true);
    const pending = await b.call("resume", { sessionId: sid });
    expect(pending.decision).toEqual(warning.decision);
    expect(pending.observation).toEqual(warning.observation);
    const answer = {
      sessionId: sid,
      replyTo: pending.decision.id,
      confirm: false,
      requestId: "stop-meal",
    };
    const stopped = await b.call("act", answer);
    expect(stopped.outcome.status).toBe("interrupted");
    expect(stopped.outcome.reason).toBe("activityStopped");
    expect(stopped.outcome.turnsElapsed).toBe(2);
    expect(stopped.decision).toBeNull();
    expect(
      stopped.events.some(
        (e: any) =>
          e.type === "actionResult" &&
          e.action === "eat" &&
          e.status === "interrupted",
      ),
    ).toBe(true);
    expect(await b.call("act", answer)).toEqual(stopped);
    const back = await b.call("resume", { sessionId: sid });
    expect(back.observation).toEqual(stopped.observation);
    expect(back.decision).toBeNull();
    const waited = await b.call("act", { sessionId: sid, action: "wait" });
    expect(waited.outcome.turnsElapsed).toBe(1);
    expect(waited.decision).toBeNull();
    expect(
      waited.observation.inventory.filter((i: any) =>
        i.label.includes("partly eaten food ration"),
      ),
    ).toEqual(
      stopped.observation.inventory.filter((i: any) =>
        i.label.includes("partly eaten food ration"),
      ),
    );
  } finally {
    await b.close();
  }
}, 15000);
