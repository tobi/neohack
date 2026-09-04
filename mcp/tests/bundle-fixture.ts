import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  openSync,
  writeSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import { TestBridge, testDirectory } from "./bridge-harness";
import { salvageRun } from "../src/salvage";
export async function bundleFixture(
  options: { large?: boolean; frameBytes?: number; empty?: boolean } = {},
) {
  const root = testDirectory("bundle-source"),
    b = new TestBridge(root);
  let id: string;
  try {
    const g = await b.newGame();
    id = g.sessionId;
    await b.call("act", {
      sessionId: id,
      action: "wait",
      requestId: "one-wait",
    });
  } finally {
    await b.close();
  }
  const path = join(root, id!, "perceptions.jsonl");
  let frames = 2;
  if (options.large || options.frameBytes) {
    // Deliberately illustrative size fixture, NOT a game-physics/history claim.
    const base = JSON.parse(readFileSync(path, "utf8").split("\n")[0]);
    base.response.provenance = {
      kind: "reconstruction",
      verification: "unverified",
      note: "Illustrative repeated-frame size fixture; not a historical reconstruction.",
    };
    base.testPadding = "x".repeat(options.frameBytes ?? 32768);
    frames = options.large
      ? Math.ceil(
          (129 * 1024 * 1024) / Buffer.byteLength(JSON.stringify(base)),
        ) + 1
      : 7;
    const fd = openSync(path, "w");
    try {
      for (let i = 0; i < frames; i++) {
        base.sequence = i;
        base.response.observation.vitals.title = `Illustrative frame ${i}`;
        writeSync(fd, JSON.stringify(base) + "\n");
      }
    } finally {
      closeSync(fd);
    }
  }
  if (options.empty) {
    writeFileSync(path, "invalid checkpoint\n");
    frames = 0;
  } else appendFileSync(path, '{"incomplete":');
  const dest = join(testDirectory("bundle-output"), "bundle");
  const result = await salvageRun(root, id!, dest, { confirm: true });
  return { root, id: id!, path, dest, frames, result };
}
