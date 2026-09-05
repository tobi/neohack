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
  "actual sandboxed Chromium art: repeatable pixels, seed variety, stable camera, strict unknown ground, output receipt",
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
    assert.equal(receipt.rendererVersion, "masonry-3d-2");
    assert.equal(receipt.layouts.length, 2);
    assert.deepEqual(receipt.checks, [
      "repeatability",
      "input-order",
      "seed-variety",
      "camera-crop",
      "unknown-ground",
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

test("observed raised doors share live/workshop anchors and bounded sprite footprints", async (t) => {
  const { chromium } = await import("playwright-core");
  const { mkdir } = await import("node:fs/promises");
  const { stdout: javascript } = await run(
    "bun",
    ["build", "src/dungeon-art.ts", "--target=browser"],
    { cwd: root },
  );
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
    headless: true,
    chromiumSandbox: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const result = await page.evaluate(async (javascript) => {
    const { renderTerrain, renderDoor } = await import(
      URL.createObjectURL(new Blob([javascript], { type: "text/javascript" }))
    );
    const assert = (ok, message) => {
      if (!ok) throw Error(message);
    };
    const states = ["closedDoor", "openDoor", "doorway"];
    const axes = [
      [
        "Side",
        [
          [0, -1],
          [0, 1],
        ],
      ],
      [
        "Front",
        [
          [-1, 0],
          [1, 0],
        ],
      ],
      ["North jamb known", [[0, -1]]],
      ["South jamb known", [[0, 1]]],
      ["West jamb known", [[-1, 0]]],
      ["East jamb known", [[1, 0]]],
      ["No jamb known", []],
    ];
    const options = { seed: 42, originX: 0, originY: 0, columns: 3, rows: 3 };
    const sheet = document.createElement("canvas");
    sheet.width = 3 * 224;
    sheet.height = 2 * 156;
    const sc = sheet.getContext("2d");
    sc.fillStyle = "#171f23";
    sc.fillRect(0, 0, sheet.width, sheet.height);
    sc.imageSmoothingEnabled = false;
    const profiles = [];
    let cases = 0;
    for (const [row, [label, neighbors]] of axes.entries()) {
      for (const [col, type] of states.entries()) {
        const cell = { x: 1, y: 1, terrain: { type } };
        const cells = [
          cell,
          ...neighbors.map(([dx, dy]) => ({
            x: 1 + dx,
            y: 1 + dy,
            terrain: { type: "wall" },
          })),
        ];
        const canvas = () => {
          const c = document.createElement("canvas");
          c.width = c.height = 48;
          return c;
        };
        const full = canvas(),
          live = canvas(),
          isolated = canvas();
        renderTerrain(full.getContext("2d"), cells, options);
        renderTerrain(live.getContext("2d"), cells, {
          ...options,
          omitDoors: true,
        });
        renderDoor(live.getContext("2d"), cell, cells, 42, 16, 16);
        assert(
          full.toDataURL() === live.toDataURL(),
          `${label} ${type}: live/workshop mismatch`,
        );
        const cropped = canvas();
        cropped.height = 16;
        renderTerrain(cropped.getContext("2d"), cells, { ...options, rows: 1 });
        const cropPixels = cropped
          .getContext("2d")
          .getImageData(0, 0, 48, 16).data;
        const fullPixels = full
          .getContext("2d")
          .getImageData(0, 0, 48, 16).data;
        assert(
          cropPixels.every((value, i) => value === fullPixels[i]),
          `${label} ${type}: frame disappears when its anchor is below the viewport`,
        );
        renderDoor(isolated.getContext("2d"), cell, cells, 42, 16, 16);
        const pixels = isolated
          .getContext("2d")
          .getImageData(0, 0, 48, 48).data;
        for (let y = 0; y < 48; y++)
          for (let x = 0; x < 48; x++) {
            if (x >= 7 && x < 32 && y < 32) continue;
            assert(
              pixels[(y * 48 + x) * 4 + 3] === 0,
              `${label} ${type}: paints outside its 25×34 sprite footprint`,
            );
          }
        assert(
          pixels.some(
            (value, i) => i % 4 === 3 && i < 16 * 48 * 4 && value > 0,
          ),
          `${label} ${type}: frame must rise above its floor tile`,
        );
        profiles.push(isolated.toDataURL());
        if (row < 2) {
          sc.fillStyle = "#e5ddc7";
          sc.font = "14px sans-serif";
          sc.fillText(
            `${label} · ${["closed", "open", "empty"][col]}`,
            col * 224 + 16,
            row * 156 + 24,
          );
          sc.drawImage(live, col * 224 + 16, row * 156 + 40, 96, 96);
          sc.drawImage(live, col * 224 + 140, row * 156 + 64);
        }
        cases++;
      }
    }
    for (let state = 0; state < 3; state++) {
      assert(
        profiles[state] !== profiles[3 + state],
        "front and side silhouettes must differ",
      );
      for (const row of [2, 3])
        assert(
          profiles[row * 3 + state] === profiles[state],
          "one side jamb retains the side profile",
        );
      for (const row of [4, 5, 6])
        assert(
          profiles[row * 3 + state] === profiles[3 + state],
          "front/unknown jamb uses front profile",
        );
    }
    for (const offset of [0, 3])
      assert(
        new Set(profiles.slice(offset, offset + 3)).size === 3,
        "closed/open/empty are visually distinct",
      );
    const hidden = document.createElement("canvas");
    hidden.width = hidden.height = 48;
    for (const type of ["unknown", "stone", "wall", "floor"])
      renderDoor(
        hidden.getContext("2d"),
        { x: 1, y: 1, terrain: { type } },
        [],
        42,
        16,
        16,
      );
    assert(
      hidden
        .getContext("2d")
        .getImageData(0, 0, 48, 48)
        .data.every((v) => v === 0),
      "only a supplied door can produce a raised fixture",
    );
    return { cases, png: sheet.toDataURL().split(",")[1] };
  }, javascript);
  assert.equal(result.cases, 21);
  await mkdir(join(root, "test-results"), { recursive: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    join(root, "test-results/neo-2-door-profiles.png"),
    Buffer.from(result.png, "base64"),
  );
});

test("3D masonry covers all junctions, uses cutaways, and crops raised offscreen anchors", async (t) => {
  const { chromium } = await import("playwright-core");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { stdout: javascript } = await run(
    "bun",
    ["build", "src/dungeon-art.ts", "--target=browser"],
    { cwd: root },
  );
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
    headless: true,
    chromiumSandbox: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const result = await page.evaluate(async (javascript) => {
    const { renderTerrain } = await import(
      URL.createObjectURL(new Blob([javascript], { type: "text/javascript" }))
    );
    const assert = (ok, message) => {
      if (!ok) throw Error(message);
    };
    const options = { seed: 42, originX: 0, originY: 0, columns: 5, rows: 5 };
    const canvas = (width = 80, height = 80) => {
      const c = document.createElement("canvas");
      c.width = width;
      c.height = height;
      return c;
    };
    const cell = (x, y, type = "wall") => ({ x, y, terrain: { type } });
    const pixels = (c) =>
      c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    const sheet = canvas(704, 768),
      sc = sheet.getContext("2d");
    sc.fillStyle = "#171f23";
    sc.fillRect(0, 0, sheet.width, sheet.height);
    sc.imageSmoothingEnabled = false;
    for (let mask = 0; mask < 16; mask++) {
      const cells = [cell(2, 2)];
      for (const [i, [dx, dy]] of [
        [0, -1],
        [1, 0],
        [0, 1],
        [-1, 0],
      ].entries())
        if (mask & (1 << i)) cells.push(cell(2 + dx, 2 + dy));
      const full = canvas(),
        reversed = canvas(),
        ground = canvas();
      renderTerrain(full.getContext("2d"), cells, options);
      renderTerrain(reversed.getContext("2d"), [...cells].reverse(), options);
      renderTerrain(ground.getContext("2d"), cells, {
        ...options,
        omitWalls: true,
        omitDoors: true,
      });
      assert(
        full.toDataURL() === reversed.toDataURL(),
        `mask ${mask}: order-dependent seams`,
      );
      const a = pixels(full),
        b = pixels(ground);
      for (let y = 0; y < 80; y++)
        for (let x = 0; x < 80; x++) {
          if (
            cells.some(
              (c) =>
                x >= c.x * 16 - 9 &&
                x < c.x * 16 + 16 &&
                y >= c.y * 16 - 18 &&
                y < c.y * 16 + 16,
            )
          )
            continue;
          const i = (y * 80 + x) * 4;
          assert(
            a.slice(i, i + 4).every((value, j) => value === b[i + j]),
            `mask ${mask}: geometry outside observed sprite bounds`,
          );
        }
      // Both the eastern overhang and the top of a wall below the viewport
      // must survive clipping even when the anchor itself is not onscreen.
      for (const [columns, rows] of [
        [2, 5],
        [5, 2],
        [2, 2],
      ]) {
        const crop = canvas(columns * 16, rows * 16);
        renderTerrain(crop.getContext("2d"), cells, {
          ...options,
          columns,
          rows,
        });
        const expected = full
          .getContext("2d")
          .getImageData(0, 0, crop.width, crop.height).data;
        assert(
          pixels(crop).every((value, i) => value === expected[i]),
          `mask ${mask}: offscreen anchor crop`,
        );
      }
      const x = (mask % 4) * 176,
        y = Math.floor(mask / 4) * 192;
      sc.fillStyle = "#e5ddc7";
      sc.font = "13px sans-serif";
      sc.fillText(
        ["N", "E", "S", "W"].filter((_, i) => mask & (1 << i)).join(" · ") ||
          "Pier",
        x + 14,
        y + 20,
      );
      sc.drawImage(full, x + 8, y + 28, 160, 160);
    }
    const rise = (cells) => {
      const full = canvas(),
        ground = canvas();
      renderTerrain(full.getContext("2d"), cells, options);
      renderTerrain(ground.getContext("2d"), cells, {
        ...options,
        omitWalls: true,
      });
      const a = pixels(full),
        b = pixels(ground);
      for (let y = 0; y < 80; y++)
        for (let x = 0; x < 80; x++) {
          const i = (y * 80 + x) * 4;
          if (a.slice(i, i + 4).some((v, j) => v !== b[i + j])) return y;
        }
      throw Error("missing wall mesh");
    };
    assert(
      rise([cell(2, 2), cell(2, 3, "floor")]) <
        rise([cell(2, 2), cell(2, 1, "floor")]),
      "foreground wall must be lower than rear wall",
    );
    assert(
      rise([cell(2, 2), cell(3, 2, "floor")]) <
        rise([cell(2, 2), cell(1, 2, "floor")]),
      "east foreground wall must be cut away",
    );
    const northCutawayRise = rise([
      cell(2, 2),
      cell(2, 1, "floor"),
    ]);
    for (const [dx, dy, label] of [
      [-1, -1, "northwest"],
      [1, -1, "northeast"],
      [-1, 1, "southwest"],
    ])
      assert(
        rise([cell(2, 2), cell(2 + dx, 2 + dy, "floor")]) ===
          northCutawayRise,
        `${label} interior must lower its foreground corner`,
      );
    assert(
      rise([cell(2, 2), cell(3, 3, "floor")]) < northCutawayRise,
      "southeast diagonal remains a rear corner",
    );
    return sheet.toDataURL().split(",")[1];
  }, javascript);
  await mkdir(join(root, "test-results"), { recursive: true });
  await writeFile(
    join(root, "test-results/neo-2-3d-junctions.png"),
    Buffer.from(result, "base64"),
  );
});
