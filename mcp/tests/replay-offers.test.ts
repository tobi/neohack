import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TestBridge, testDirectory } from "./bridge-harness";
import { createRunStore } from "../src/runs";
for (const kind of ["confirmation", "command", "menu"])
  test(`replay refuses a well-shaped but unoffered ${kind} value`, async () => {
    const root = testDirectory(`offer-${kind}`),
      a = new TestBridge(root),
      b = new TestBridge(root);
    let id: string;
    try {
      let g = await a.newGame();
      id = g.sessionId;
      if (kind === "menu") {
        for (const name of ["food ration", "dagger"]) {
          const item = g.observation.inventory.find((i: any) =>
            i.label.includes(name),
          );
          g = await a.call("act", {
            sessionId: id,
            action: "drop",
            item: { id: item.id },
          });
          expect(g.error).toBeUndefined();
        }
        // Actual two-object engine menu with an identity-bound successful pick.
        const pickup = await a.call("act", {
          sessionId: id,
          action: "pickup",
          item: "food ration",
        });
        expect(pickup.error).toBeUndefined();
        expect(pickup.outcome.status).toBe("completed");
      } else {
        const p = await a.call("act", { sessionId: id, action: "pray" });
        expect(p.decision.kind).toBe("confirmation");
        await a.call("act", {
          sessionId: id,
          replyTo: p.decision.id,
          confirm: false,
        });
      }
      await a.close();
      const path = join(root, id, "input.log.jsonl"),
        lines = readFileSync(path, "utf8")
          .trimEnd()
          .split("\n")
          .map(JSON.parse);
      const field =
        kind === "confirmation"
          ? "answer"
          : kind === "command"
            ? "index"
            : "picks";
      const entry = lines.findLast((line: any) =>
        Object.hasOwn(line.result ?? {}, field),
      );
      expect(entry).toBeDefined();
      entry.result[field] =
        kind === "confirmation" ? "!" : kind === "command" ? 4096 : [1023];
      const input = lines.map(JSON.stringify).join("\n") + "\n";
      writeFileSync(path, input);
      const metadata = join(root, id, "meta.json"),
        meta = JSON.parse(readFileSync(metadata, "utf8"));
      meta.inputBytes = Buffer.byteLength(input);
      writeFileSync(metadata, JSON.stringify(meta));
      const data = readFileSync(join(root, id, "perceptions.jsonl"), "utf8");
      expect((await b.call("resume", { sessionId: id })).error.code).toBe(
        "replayMismatch",
      );
      expect(readFileSync(path, "utf8")).toBe(input);
      expect(readFileSync(join(root, id, "perceptions.jsonl"), "utf8")).toBe(
        data,
      );
      if (process.platform === "linux")
        expect(
          readFileSync(
            `/proc/${b.proc.pid}/task/${b.proc.pid}/children`,
            "utf8",
          ).trim(),
        ).toBe("");
    } finally {
      await a.close();
      await b.close();
    }
  });

test("duplicate checkpoint keys cannot supply either native recovery or a read-only authoritative frame", async () => {
  const root = testDirectory("duplicate-checkpoint"),
    a = new TestBridge(root),
    b = new TestBridge(root);
  try {
    const g = await a.newGame(),
      id = g.sessionId;
    await a.close();
    const path = join(root, id, "perceptions.jsonl");
    const damaged = readFileSync(path, "utf8").replace(
      '"sequence":0',
      '"sequence":0,"sequence":0',
    );
    writeFileSync(path, damaged);
    const input = readFileSync(join(root, id, "input.log.jsonl"), "utf8");
    expect((await b.call("resume", { sessionId: id })).error.code).toBe(
      "recordingUnavailable",
    );
    const snapshot = await createRunStore(root).snapshot(id);
    expect(snapshot.integrity.state).toBe("corrupt");
    expect(snapshot.rows).toHaveLength(0);
    expect(readFileSync(path, "utf8")).toBe(damaged);
    expect(readFileSync(join(root, id, "input.log.jsonl"), "utf8")).toBe(input);
  } finally {
    await a.close();
    await b.close();
  }
});
