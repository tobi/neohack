import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "..");

test("unknown corridor edges differ from known walls in every neighbor pattern", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "neonethack-edges-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const bundle = join(temporary, "renderer.js");
  await promisify(execFile)(
    "bun",
    ["build", "src/dungeon-art.ts", "--outfile", bundle],
    { cwd: root },
  );
  const source = await readFile(bundle, "utf8");
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
    headless: true,
    chromiumSandbox: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 760, height: 440 } });
  const checked = await page.evaluate(async (source) => {
    const { renderTerrain } = await import(
      URL.createObjectURL(new Blob([source], { type: "text/javascript" }))
    );
    const directions = [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ];
    const centers = [
      [8, 0],
      [15, 8],
      [8, 15],
      [0, 8],
    ];
    const cell = (x, y, type) => ({ x, y, terrain: { type } });
    function render(mask, boundary) {
      const cells = [cell(1, 1, "corridor")];
      for (let side = 0; side < 4; side++) {
        const [dx, dy] = directions[side];
        const type = mask & (1 << side) ? "corridor" : boundary;
        if (type) cells.push(cell(1 + dx, 1 + dy, type));
      }
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 48;
      const context = canvas.getContext("2d");
      context.fillStyle = "#171f23";
      context.fillRect(0, 0, 48, 48);
      renderTerrain(context, cells, {
        seed: 42,
        originX: 0,
        originY: 0,
        columns: 3,
        rows: 3,
      });
      return canvas;
    }
    const pixel = (canvas, x, y) =>
      [...canvas.getContext("2d").getImageData(x, y, 1, 1).data].join(",");
    let checked = 0;
    for (let mask = 0; mask < 16; mask++) {
      const wall = render(mask, "wall");
      const absent = render(mask, undefined);
      for (const boundary of [
        undefined,
        "unknown",
        "dark",
        "stone",
        "unexplored",
      ]) {
        const fog = render(mask, boundary);
        if (fog.toDataURL() !== absent.toDataURL())
          throw Error(`Unknown representation differs: ${boundary}`);
        for (let side = 0; side < 4; side++) {
          if (mask & (1 << side)) continue;
          const [x, y] = centers[side];
          if (pixel(fog, x + 16, y + 16) === pixel(wall, x + 16, y + 16))
            throw Error(
              `Fog looks closed: mask ${mask}, side ${side}, ${boundary}`,
            );
          const [dx, dy] = directions[side];
          for (let py = 0; py < 16; py++)
            for (let px = 0; px < 16; px++) {
              if (
                pixel(fog, (1 + dx) * 16 + px, (1 + dy) * 16 + py) !==
                "23,31,35,255"
              )
                throw Error("Unknown cell was painted");
            }
          checked++;
        }
      }
    }
    document.body.style.cssText =
      "margin:20px;background:#171f23;color:#ded7ba;font:14px monospace";
    const heading = document.createElement("h3");
    heading.textContent = "Corridor edges — darkness vs known walls (1× / 2×)";
    document.body.append(heading);
    for (const [label, boundary] of [
      ["Unexplored: broken trim", undefined],
      ["Known wall: solid trim", "wall"],
    ]) {
      const title = document.createElement("p");
      title.textContent = label + " · end / straight / corner / junction";
      document.body.append(title);
      for (const mask of [2, 5, 3, 7]) {
        const native = render(mask, boundary);
        native.style.marginRight = "8px";
        const enlarged = native.cloneNode();
        enlarged.getContext("2d").drawImage(native, 0, 0);
        enlarged.style.cssText =
          "width:96px;height:96px;image-rendering:pixelated;margin-right:24px";
        document.body.append(native, enlarged);
      }
    }
    return checked;
  }, source);
  assert.equal(checked, 160);
  await mkdir(join(root, "test-results"), { recursive: true });
  await page.screenshot({
    path: join(root, "test-results/neo-1-corridor-edges.png"),
  });
});
