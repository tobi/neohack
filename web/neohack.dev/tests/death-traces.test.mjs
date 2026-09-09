import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
const root = resolve(import.meta.dirname, "..");
test("death impressions require explicit events, age by turns and cannot refresh from replay", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "neohack-death-art-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  execFileSync(
    "bun",
    ["build", "src/death-traces.ts", "--outfile", join(temp, "traces.js")],
    { cwd: root },
  );
  const source = await readFile(join(temp, "traces.js"), "utf8");
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
    headless: true,
    chromiumSandbox: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const result = await page.evaluate(async (source) => {
    const { DeathTraces } = await import(
      URL.createObjectURL(new Blob([source], { type: "text/javascript" }))
    );
    const traces = new DeathTraces();
    const state = (revision, turn, events = []) => ({
      sessionId: "test",
      revision,
      events,
      observation: { turn, location: { id: "L" } },
    });
    traces.observe(
      state(1, 10),
      state(2, 11, [{ type: "heard", text: "You kill the goblin!" }]),
    );
    const noGuess = traces.entries.length === 0;
    const death = {
      type: "creatureDied",
      levelId: "L",
      x: 4,
      y: 5,
      turn: 12,
      appearance: "goblin",
    };
    traces.observe(state(2, 11), state(3, 12, [death]));
    const born = traces.entries[0];
    traces.observe(state(2, 11), state(3, 12, [death]));
    traces.observe(state(3, 12), state(4, 13));
    traces.observe(state(2, 11), state(3, 12, [death]));
    const dedup = traces.entries.length === 1 && traces.entries[0].turn === 12;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const c = canvas.getContext("2d");
    const opacity = (age) => {
      c.clearRect(0, 0, 32, 32);
      traces.draw(c, born, 8, 8, 12 + age);
      return [...c.getImageData(0, 0, 32, 32).data]
        .filter((_, i) => i % 4 === 3)
        .reduce((a, b) => a + b, 0);
    };
    const fade = [0, 4, 5, 6, 7].map(opacity);
    traces.age(18);
    const kept = traces.entries.length === 1;
    traces.age(19);
    const gone = traces.entries.length === 0;
    traces.clear();
    traces.observe(
      state(1, 20),
      state(2, 21, [{ ...death, levelId: "elsewhere" }]),
    );
    const foreign = traces.entries.length === 0;
    return { noGuess, dedup, fade, kept, gone, foreign };
  }, source);
  assert.ok(
    result.noGuess &&
      result.dedup &&
      result.kept &&
      result.gone &&
      result.foreign,
  );
  const [first, steady, late, last, gone] = result.fade;
  assert.ok(
    first > 0 &&
      first === steady &&
      late < steady &&
      last < late &&
      last > 0 &&
      gone === 0,
  );
});
