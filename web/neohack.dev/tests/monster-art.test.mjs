import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
test("monster source coverage, native atlas and uncertain portraits preserve perception", () => {
  for (const [command, args] of [
    ["node", ["scripts/generate-monster-art.mjs", "--check"]],
    ["bun", ["scripts/render-monsters.ts"]],
  ]) {
    const result = spawnSync(command, args, {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
});
