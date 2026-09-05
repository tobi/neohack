import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { parseLayout } from "../scripts/dungeon-layout.ts";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");

test("workshop layout preserves coordinates and explicitly distinguishes corridors, doors and unknowns", () => {
  const result = parseLayout(" |-.#\r\n +/@ \r\n");
  assert.equal(result.columns, 5);
  assert.equal(result.rows, 2);
  assert.deepEqual(
    result.cells.map(({ x, y, terrain }) => [x, y, terrain.type]),
    [
      [1, 0, "wall"],
      [2, 0, "wall"],
      [3, 0, "floor"],
      [4, 0, "corridor"],
      [1, 1, "closedDoor"],
      [2, 1, "openDoor"],
      [3, 1, "floor"],
    ],
  );
  assert.deepEqual(result.actors, [{ x: 3, y: 1, mark: "@" }]);
  assert.throws(
    () => parseLayout("...\n.!."),
    /Unsupported layout symbol "!" at line 2, column 2/,
  );
  assert.throws(() => parseLayout("..\t"), /Unsupported layout symbol/);
  assert.throws(() => parseLayout(""), /1–160/);
  assert.throws(() => parseLayout(".".repeat(161)), /1–160/);
});

test(
  "actual sandboxed Chromium art: repeatable pixels, seed variety, stable camera, strict unknown cells, output receipt",
  { timeout: 30000 },
  async (t) => {
    const temporary = await mkdtemp(join(tmpdir(), "neonethack-art-"));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const output = join(temporary, "comparison.png");
    const args = [
      "scripts/render-dungeon.ts",
      "--compare",
      "1,314159",
      "--scale",
      "1",
      "--out",
      output,
      "--verify",
    ];
    const first = await run("bun", args, { cwd: root, timeout: 20000 });
    const receipt = JSON.parse(
      await readFile(output.replace(".png", ".json"), "utf8"),
    );
    const png = await readFile(output);
    assert.equal(
      createHash("sha256").update(png).digest("hex"),
      receipt.outputSha256,
    );
    assert.equal(JSON.parse(first.stdout).outputSha256, receipt.outputSha256);
    assert.equal(receipt.rendererVersion, "stonework-2");
    assert.equal(receipt.layouts.length, 2);
    assert.deepEqual(receipt.checks, [
      "repeatability",
      "input-order",
      "seed-variety",
      "camera-crop",
      "unknown-cells",
      "explicit-unknown-types",
      "future-terrain",
    ]);
    await run("bun", args, { cwd: root, timeout: 20000 });
    assert.deepEqual(
      await readFile(output),
      png,
      "independent browser processes produce identical PNGs",
    );
  },
);
