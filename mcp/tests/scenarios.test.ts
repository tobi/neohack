// Real engine scenarios: no fabricated maps, debug wishes or hidden-state peeks.
import { expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { TestBridge, testDirectory } from "./bridge-harness";
import { STAIRS_ROUTE } from "./scenario-fixtures";

async function scenario(
  fn: (b: TestBridge, g: any) => Promise<void>,
  seed = 42,
) {
  const b = new TestBridge(testDirectory("scenario"));
  try {
    await fn(b, await b.newGame(seed));
  } finally {
    await b.close();
  }
}
function child(b: TestBridge) {
  const ids = readFileSync(
    `/proc/${b.proc.pid}/task/${b.proc.pid}/children`,
    "utf8",
  )
    .trim()
    .split(/\s+/)
    .map(Number);
  expect(ids.length).toBe(1);
  expect(readFileSync(`/proc/${ids[0]}/cmdline`, "utf8")).toContain(b.sessions);
  return ids[0];
}

test("walking into a real pet exchanges places without attacking self", () =>
  scenario(async (b, g) => {
    const ally = g.observation.world.find(
      (c: any) => c.occupant?.kind === "ally",
    );
    expect({ x: ally.x, y: ally.y }).toEqual({ x: 19, y: 6 });
    const r = await b.call("act", {
      sessionId: g.sessionId,
      action: "move",
      direction: "southeast",
    });
    expect(r.observation.you).toEqual({ x: ally.x, y: ally.y });
    expect(r.outcome.effects).toContain("swappedPlaces");
    expect(r.outcome.effects).not.toContain("attacked");
    expect(r.outcome.turnsElapsed).toBe(1);
    expect(
      r.observation.world.filter((c: any) => c.occupant?.kind === "self"),
    ).toHaveLength(1);
    expect(
      r.observation.world.find((c: any) => c.occupant?.kind === "self").occupant
        .kind,
    ).not.toBe("creature");
  }));

test("a genuinely locked door reports its actual zero-turn failed opening", () =>
  scenario(async (b, g) => {
    let r = g;
    for (let i = 0; i < 8; i++)
      r = await b.call("act", {
        sessionId: g.sessionId,
        action: "move",
        direction: "east",
      });
    expect(r.observation.you).toEqual({ x: 44, y: 14 });
    expect(
      r.observation.world.find((c: any) => c.x === 45 && c.y === 14).terrain
        .type,
    ).toBe("closedDoor");
    const opened = await b.call("act", {
      sessionId: g.sessionId,
      action: "open",
      target: { direction: "east" },
    });
    expect(opened.outcome.status).toBe("blocked");
    expect(opened.outcome.reason).toBe("lockedDoor");
    expect(opened.outcome.turnsElapsed).toBe(0);
    expect(opened.observation.turn).toBe(r.observation.turn);
    expect(
      opened.observation.world.find((c: any) => c.x === 45 && c.y === 14)
        .terrain.type,
    ).toBe("closedDoor");
    expect(
      (await b.call("get_state", { sessionId: g.sessionId })).observation,
    ).toEqual(opened.observation);
  }, 24));

test("real stairs replace the active map and restore remembered terrain on return", () =>
  scenario(async (b, g) => {
    let r = g;
    for (const direction of STAIRS_ROUTE)
      r = await b.call("act", {
        sessionId: g.sessionId,
        action: "move",
        direction,
      });
    expect(r.observation.you).toEqual({ x: 64, y: 3 });
    const stair = r.observation.world.find((c: any) => c.x === 64 && c.y === 3);
    expect(stair.terrain.type).toBe("stairsDown");
    const remembered = r.observation.world.find(
      (c: any) => c.terrain.type === "stairsUp",
    );
    expect(remembered).toBeDefined();
    const inspected = await b.call("act", {
      sessionId: g.sessionId,
      action: "inspect",
      target: "here",
    });
    expect(inspected.outcome.effects).toContain("inspectedHere");
    expect(inspected.outcome.turnsElapsed).toBe(0);
    const down = await b.call("act", {
      sessionId: g.sessionId,
      action: "climb",
      direction: "down",
    });
    expect(down.outcome.effects).toContain("descendedStairs");
    expect(down.outcome.turnsElapsed).toBe(1);
    expect(down.observation.location.id).not.toBe(r.observation.location.id);
    expect(down.observation.you).toEqual({ x: 13, y: 4 });
    expect(down.observation.world.some((c: any) => c.x >= 55)).toBe(false);
    const up = await b.call("act", {
      sessionId: g.sessionId,
      action: "climb",
      direction: "up",
    });
    expect(up.outcome.effects).toContain("climbedStairs");
    expect(up.observation.location.id).toBe(r.observation.location.id);
    expect(up.observation.you).toEqual(r.observation.you);
    expect(
      up.observation.world.find((c: any) => c.x === 64 && c.y === 3).terrain
        .type,
    ).toBe("stairsDown");
    expect(
      up.observation.world.find(
        (c: any) => c.x === remembered.x && c.y === remembered.y,
      ).terrain.type,
    ).toBe("stairsUp");
    expect(
      (await b.call("get_state", { sessionId: g.sessionId })).observation,
    ).toEqual(up.observation);
  }, 7));

test(
  "fatal prayer has an engine cause, final health, durable receipt and cold terminal observation",
  () =>
    scenario(async (b, g) => {
      let r = g,
        fatal: any;
      // Explicitly confirm this deliberately lethal test scenario. No UI does so.
      for (let i = 0; i < 20 && !r.ended; i++) {
        r = await b.call("act", { sessionId: g.sessionId, action: "pray" });
        expect(r.decision?.kind).toBe("confirmation");
        fatal = {
          sessionId: g.sessionId,
          replyTo: r.decision.id,
          confirm: true,
          requestId: `prayer-${i}`,
        };
        r = await b.call("act", fatal);
      }
      expect(r.ended).toBe(true);
      expect(r.end.kind).toBe("death");
      expect(r.end.cause).toMatch(/^killed by /);
      expect(r.end.turn).toBe(r.observation.turn);
      expect(r.observation.vitals.health).toBe(0);
      expect(r.decision).toBeNull();
      expect(r.events.find((e: any) => e.type === "ended")?.cause).toBe(
        r.end.cause,
      );
      const seen = await b.call("get_state", { sessionId: g.sessionId });
      expect(seen.observation).toEqual(r.observation);
      expect(seen.end).toEqual(r.end);
      expect(await b.call("act", fatal)).toEqual(r);
      const fresh = new TestBridge(b.sessions);
      try {
        const restored = await fresh.call("resume", { sessionId: g.sessionId });
        expect(restored.error).toBeUndefined(); // Dead engines no longer retain leases.
        expect(restored.end).toEqual(r.end);
        expect(restored.observation).toEqual(r.observation);
        expect(await fresh.call("act", fatal)).toEqual(r);
        expect(
          (await fresh.call("act", { sessionId: g.sessionId, action: "wait" }))
            .error.code,
        ).toBe("gameEnded");
      } finally {
        await fresh.close();
      }
    }),
  15000,
);

test("leaving the first upstairs requires consent and is escape, not ascension or death", () =>
  scenario(async (b, g) => {
    const up = await b.call("act", {
      sessionId: g.sessionId,
      action: "climb",
      direction: "up",
    });
    expect(up.decision.kind).toBe("confirmation");
    const no = await b.call("act", {
      sessionId: g.sessionId,
      replyTo: up.decision.id,
      confirm: false,
    });
    expect(no.ended).toBe(false);
    expect(no.observation.turn).toBe(g.observation.turn);
    const again = await b.call("act", {
      sessionId: g.sessionId,
      action: "climb",
      direction: "up",
    });
    const yes = await b.call("act", {
      sessionId: g.sessionId,
      replyTo: again.decision.id,
      confirm: true,
    });
    expect(yes.ended).toBe(true);
    expect(yes.end.kind).toBe("escaped");
    expect(yes.end.cause).toBe("escaped");
    expect(yes.observation.vitals.health).toBeGreaterThan(0);
    expect(yes.decision).toBeNull();
    expect((await b.call("get_state", { sessionId: g.sessionId })).end).toEqual(
      yes.end,
    );
  }));

test.skipIf(process.platform !== "linux")(
  "an actually killed engine is an error, never a fabricated death",
  () =>
    scenario(async (b, g) => {
      const offer = await b.call("act", {
        sessionId: g.sessionId,
        action: "eat",
      });
      expect(offer.decision.kind).toBe("item");
      process.kill(child(b), "SIGKILL");
      let r = g;
      for (let i = 0; i < 20 && !r.ended; i++)
        r = await b.call("get_state", { sessionId: g.sessionId });
      expect(r.ended).toBe(true);
      expect(r.end.kind).toBe("engineError");
      expect(r.end.cause).toBeUndefined();
      expect(r.outcome.status).toBe("unknown");
      expect(r.decision).toBeNull();
      expect(r.observation.vitals.health).toBeGreaterThan(0);
      const metadata = JSON.parse(
        readFileSync(`${b.sessions}/${g.sessionId}/run.json`, "utf8"),
      );
      expect(metadata.end.kind).toBe("engineError");
      expect(metadata.ended).toBe(true);
      const back = await b.call("resume", { sessionId: g.sessionId });
      expect(back.ended).toBe(false);
      expect(back.observation).toEqual(g.observation);
      expect(back.decision).toEqual(offer.decision);
    }),
);

test.skipIf(process.platform !== "linux")(
  "a stopped engine cannot hang teardown or strand its run lease",
  () =>
    scenario(async (b, g) => {
      const pid = child(b);
      process.kill(pid, "SIGSTOP");
      const start = performance.now();
      const end = await b.call("end_session", { sessionId: g.sessionId });
      expect(performance.now() - start).toBeLessThan(3500);
      expect(end.end.kind).toBe("disconnected");
      expect(existsSync(`/proc/${pid}`)).toBe(false); // Reaped, not a lingering zombie.
      const fresh = new TestBridge(b.sessions);
      try {
        const back = await fresh.call("resume", { sessionId: g.sessionId });
        expect(back.error).toBeUndefined();
        expect(back.observation).toEqual(g.observation);
      } finally {
        await fresh.close();
      }
    }),
  10000,
);
