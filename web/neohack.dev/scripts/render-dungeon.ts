#!/usr/bin/env bun
import { layoutProfile, type LayoutType } from "../src/layout-art";
import { resolve, dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { chromium } from "playwright-core";
import { parseLayout, LEGEND } from "./dungeon-layout.ts";
import { RENDERER_VERSION } from "../src/dungeon-art.ts";

const root = resolve(import.meta.dir, "..");
const help = `Seeded dungeon art workshop (Bun + sandboxed Chromium)

bun scripts/render-dungeon.ts --layout art/layouts/rooms.txt --seed 314159 --out test-results/art/rooms.png
bun scripts/render-dungeon.ts --compare 1,314159,8675309 --out test-results/art/comparison.png --verify

  --layout PATH     Explicit NetHack-style ASCII art layout (repeatable).
  --layout-type TYPE  Art profile: dungeon (default), dungeon-damp or cave; never changes the layout.
  --seed TEXT       Surface seed, default 314159; pass the game's seed for matching art.
  --scale INTEGER   Pixel scale from 1 to 6; default 3.
  --out PATH        PNG destination; JSON receipt is written alongside it.
  --compare SEEDS   Comma-separated seeds; without --layout compares both sample layouts.
  --verify          Check repeatability, input order, camera crop, unknowns, and seed variety.
  --help            Print usage and legend.

${Object.entries(LEGEND)
  .map(([mark, type]) => `  ${JSON.stringify(mark).padEnd(5)} ${type}`)
  .join("\n")}

The @ marker is explicit offline input and drawn as a small gold diamond.
CHROMIUM may override /usr/bin/chromium. Browser sandboxing stays enabled.
`;
function args() {
  const result = {
    layouts: [] as string[],
    layoutType: "dungeon" as LayoutType,
    seed: "314159",
    scale: 3,
    out: "test-results/art/dungeon.png",
    compare: null as string[] | null,
    verify: false,
  };
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i]!;
    if (arg === "--help") {
      process.stdout.write(help);
      process.exit(0);
    }
    if (arg === "--verify") {
      result.verify = true;
      continue;
    }
    if (!["--layout", "--layout-type", "--seed", "--scale", "--out", "--compare"].includes(arg))
      throw new Error(`Unknown argument ${arg}. Use --help.`);
    const value = process.argv[++i];
    if (!value || value.startsWith("--"))
      throw new Error(`${arg} needs a value.`);
    if (arg === "--layout") result.layouts.push(resolve(value));
    else if (arg === "--layout-type") { layoutProfile(value as LayoutType); result.layoutType = value as LayoutType; }
    else if (arg === "--seed") result.seed = value;
    else if (arg === "--out") result.out = resolve(value);
    else if (arg === "--scale") result.scale = Number(value);
    else result.compare = value.split(",");
  }
  if (!Number.isInteger(result.scale) || result.scale < 1 || result.scale > 6)
    throw new Error("--scale must be an integer from 1 to 6.");
  if (!result.out.endsWith(".png")) throw new Error("--out must end in .png.");
  if (
    result.compare &&
    (result.compare.some((seed) => !seed) || result.compare.length > 6)
  )
    throw new Error("--compare needs 1–6 nonempty seeds.");
  if (result.layouts.length > 8)
    throw new Error("At most eight layouts can be compared at once.");
  if (!result.layouts.length)
    result.layouts = result.compare
      ? [
          join(root, "art/layouts/rooms.txt"),
          join(root, "art/layouts/waterworks.txt"),
        ]
      : [join(root, "art/layouts/rooms.txt")];
  return result;
}
const digest = (input: string | Uint8Array) =>
  createHash("sha256").update(input).digest("hex");

try {
  const options = args();
  const layouts = await Promise.all(
    options.layouts.map(async (path) => {
      const text = await Bun.file(path).text();
      return {
        name: path.split("/").at(-1)!,
        inputSha256: digest(text),
        ...parseLayout(text),
      };
    }),
  );
  const build = await Bun.build({
    entrypoints: [join(root, "src/dungeon-art.ts")],
    target: "browser",
    minify: false,
  });
  if (!build.success)
    throw new Error(`Renderer build failed: ${build.logs.join("\n")}`);
  const javascript = await build.outputs[0]!.text();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/renderer.js")
        return new Response(javascript, {
          headers: { "Content-Type": "application/javascript" },
        });
      if (path === "/")
        return new Response(
          '<!doctype html><html lang="en"><title>Dungeon art workshop</title><body></body></html>',
          { headers: { "Content-Type": "text/html" } },
        );
      return new Response("Not found", { status: 404 });
    },
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
      headless: true,
      chromiumSandbox: true,
    });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/`);
    const seeds = options.compare ?? [options.seed];
    const result = await page.evaluate(
      async ({ layouts, seeds, scale, verify, layoutType }) => {
        const rendererUrl = "/renderer.js";
        const { renderTerrain } = await import(rendererUrl);
        const background = "#171f23";
        function terrain(
          layout: Pick<(typeof layouts)[number], "cells" | "columns" | "rows">,
          seed: string,
          originX = 0,
          originY = 0,
          columns = layout.columns,
          rows = layout.rows,
          reverse = false,
          omitDoors = false,
        ) {
          const canvas = document.createElement("canvas");
          canvas.width = columns * 16;
          canvas.height = rows * 16;
          const c = canvas.getContext("2d")!;
          c.fillStyle = background;
          c.fillRect(0, 0, canvas.width, canvas.height);
          renderTerrain(
            c,
            reverse ? [...layout.cells].reverse() : layout.cells,
            {
              seed,
              layoutType,
              originX,
              originY,
              columns,
              rows,
              omitDoors,
              omitWalls: omitDoors,
            },
          );
          return canvas;
        }
        const checks: string[] = [];
        if (verify) {
          const assert = (condition: boolean, message: string) => {
            if (!condition)
              throw new Error(`Renderer invariant failed: ${message}`);
          };
          for (const layout of layouts) {
            const full = terrain(layout, seeds[0]!);
            const first = full.toDataURL();
            assert(
              first === terrain(layout, seeds[0]!).toDataURL(),
              `${layout.name}: repeatability`,
            );
            assert(
              first ===
                terrain(
                  layout,
                  seeds[0]!,
                  0,
                  0,
                  layout.columns,
                  layout.rows,
                  true,
                ).toDataURL(),
              `${layout.name}: input order`,
            );
            assert(
              first !==
                terrain(
                  layout,
                  `${seeds[0]}:another-material-seed`,
                ).toDataURL(),
              `${layout.name}: seed variety`,
            );
            if (layout.columns > 4 && layout.rows > 4) {
              const cols = layout.columns - 3,
                rows = layout.rows - 3;
              const crop = terrain(layout, seeds[0]!, 2, 2, cols, rows);
              const a = full
                .getContext("2d")!
                .getImageData(32, 32, cols * 16, rows * 16).data;
              const b = crop
                .getContext("2d")!
                .getImageData(0, 0, cols * 16, rows * 16).data;
              assert(
                a.every((v, i) => v === b[i]),
                `${layout.name}: camera crop`,
              );
            }
            const known = new Set(
              layout.cells.map((cell) => `${cell.x},${cell.y}`),
            );
            // Unknown ground remains empty. The separate fixture pass may
            // project observed masonry above its own anchor, like an actor.
            const pixels = terrain(
              layout,
              seeds[0]!,
              0,
              0,
              layout.columns,
              layout.rows,
              false,
              true,
            )
              .getContext("2d")!
              .getImageData(0, 0, full.width, full.height).data;
            for (let y = 0; y < layout.rows * 16; y++)
              for (let x = 0; x < layout.columns * 16; x++) {
                if (known.has(`${Math.floor(x / 16)},${Math.floor(y / 16)}`))
                  continue;
                const i = (y * full.width + x) * 4;
                assert(
                  pixels[i] === 23 &&
                    pixels[i + 1] === 31 &&
                    pixels[i + 2] === 35 &&
                    pixels[i + 3] === 255,
                  `${layout.name}: unknown cell at ${x},${y}`,
                );
              }
          }
          const hidden = {
            name: "hidden",
            columns: 5,
            rows: 1,
            actors: [],
            cells: ["unknown", "dark", "stone", "unexplored"].map(
              (type, x) => ({ x, y: 0, terrain: { type } }),
            ),
          };
          const hiddenPixels = terrain(hidden, seeds[0]!)
            .getContext("2d")!
            .getImageData(0, 0, 80, 16).data;
          assert(
            hiddenPixels.every((v, i) => v === [23, 31, 35, 255][i % 4]),
            "explicit unknown types leave every pixel dark",
          );
          const future = {
            name: "future",
            columns: 1,
            rows: 1,
            actors: [],
            cells: [{ x: 0, y: 0, terrain: { type: "futureTerrain" } }],
          };
          const futurePixels = terrain(future, seeds[0]!)
            .getContext("2d")!
            .getImageData(0, 0, 16, 16).data;
          assert(
            futurePixels[0] === 23 &&
              futurePixels[1] === 31 &&
              futurePixels[2] === 35,
            "future terrain is not painted as floor",
          );
          assert(
            futurePixels[(3 * 16 + 5) * 4] !== 23,
            "future terrain has a visible uncertainty marker",
          );
          checks.push(
            "repeatability",
            "input-order",
            "seed-variety",
            "camera-crop",
            "unknown-ground",
            "explicit-unknown-types",
            "future-terrain",
          );
        }
        const panelWidth =
          (Math.max(...layouts.map((layout) => layout.columns)) + 2) * 16 * scale;
        const comparison = layouts.length * seeds.length > 1;
        const gap = comparison ? 24 : 0,
          label = comparison ? 48 : 0;
        const width =
          panelWidth * seeds.length +
          gap * (seeds.length + (comparison ? 1 : 0));
        const height = layouts.reduce(
          (sum, layout) => sum + (layout.rows + 3) * 16 * scale + label + gap,
          comparison ? gap : 0,
        );
        if (width > 16000 || height > 16000)
          throw new Error(
            "Comparison exceeds 16000 pixels. Reduce scale or number of layouts.",
          );
        const sheet = document.createElement("canvas");
        sheet.width = width;
        sheet.height = height;
        const c = sheet.getContext("2d")!;
        c.imageSmoothingEnabled = false;
        c.fillStyle = background;
        c.fillRect(0, 0, width, height);
        let sy = comparison ? gap : 0;
        for (const layout of layouts) {
          for (let i = 0; i < seeds.length; i++) {
            const sx = comparison ? gap + i * (panelWidth + gap) : 0,
              seed = seeds[i]!;
            if (comparison) {
              c.fillStyle = "#ded7ba";
              c.font = "16px monospace";
              c.fillText(layout.name, sx, sy + 17);
              c.fillStyle = "#9cab96";
              c.font = "13px monospace";
              c.fillText(
                `${layoutType} · SEED ${seed} · ${layout.columns} × ${layout.rows}`,
                sx,
                sy + 36,
              );
            }
            const native = terrain(layout, seed, -1, -2, layout.columns + 2, layout.rows + 3);
            const n = native.getContext("2d")!;
            // Explicit ASCII @ only; this workshop has no creature inference.
            for (const actor of layout.actors) {
              n.fillStyle = "#252e29";
              n.fillRect((actor.x + 1) * 16 + 3, (actor.y + 2) * 16 + 3, 10, 10);
              n.fillStyle = "#e9cf8b";
              n.fillRect((actor.x + 1) * 16 + 7, (actor.y + 2) * 16 + 3, 2, 10);
              n.fillRect((actor.x + 1) * 16 + 5, (actor.y + 2) * 16 + 5, 6, 6);
            }
            c.drawImage(
              native,
              sx,
              sy + label,
              native.width * scale,
              native.height * scale,
            );
          }
          sy += (layout.rows + 3) * 16 * scale + label + gap;
        }
        return {
          image: sheet.toDataURL("image/png").split(",")[1]!,
          width,
          height,
          checks,
        };
      },
      { layouts, seeds, scale: options.scale, verify: options.verify, layoutType: options.layoutType },
    );
    const png = Buffer.from(result.image, "base64");
    const receipt = {
      rendererVersion: RENDERER_VERSION,
      layoutType: options.layoutType,
      sourceSha256: digest(
        (
          await Promise.all(
            ["dungeon-art.ts", "structure-sprites.ts", "ambience.ts", "layout-art.ts", "../art/layout-types/defaults/profile.json", "../art/layout-types/dungeon/profile.json", "../art/layout-types/cave/profile.json", "../art/layout-types/dungeon-damp/profile.json"].map((name) =>
              Bun.file(join(root, "src", name)).text(),
            ),
          )
        ).join("\n"),
      ),
      seeds,
      scale: options.scale,
      nativeCellPixels: 16,
      previewPaddingCells: { left: 1, top: 2, right: 1, bottom: 1 },
      apparentWallRisePixels: 15,
      cutawayWallRisePixels: 4.5,
      maximumStructureRisePixels: 18,
      structureProjection: { xPerHeight: -0.375, yPerHeight: -0.75 },
      width: result.width,
      height: result.height,
      outputSha256: digest(png),
      layouts: layouts.map(({ name, inputSha256, columns, rows, cells }) => ({
        name,
        inputSha256,
        columns,
        rows,
        knownCells: cells.length,
      })),
      checks: result.checks,
      browser: browser.version(),
    };
    await mkdir(dirname(options.out), { recursive: true });
    await Bun.write(options.out, png);
    await Bun.write(
      options.out.replace(/\.png$/, ".json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    process.stdout.write(
      `${JSON.stringify({ png: resolve(options.out), receipt: resolve(options.out.replace(/\.png$/, ".json")), ...receipt }, null, 2)}\n`,
    );
  } finally {
    await browser?.close();
    await server.stop(true);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
}
