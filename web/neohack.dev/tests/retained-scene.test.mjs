import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "neohack-retained-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = join(directory, "entry.ts");
  await writeFile(
    entry,
    ["dungeon-art", "terrain-scene", "retained-scene"]
      .map(
        (name) =>
          `export * from ${JSON.stringify(join(root, "src", name + ".ts"))};`,
      )
      .join("\n"),
  );
  const javascript = execFileSync("bun", ["build", entry, "--target=browser"], {
    encoding: "utf8",
  });
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
    chromiumSandbox: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.evaluate(async (javascript) => {
    window.art = await import(
      URL.createObjectURL(new Blob([javascript], { type: "text/javascript" }))
    );
  }, javascript);
  return page;
}

test("cave atlas preserves pre-rewrite pixels across seeds, cache reuse and eviction", async (t) => {
  const page = await fixture(t);
  const result = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 160;
    c.height = 96;
    const ctx = c.getContext("2d");
    const world = Array.from({ length: 60 }, (_, i) => ({
      x: (i % 10) - 3,
      y: Math.floor(i / 10) - 2,
      terrain: { type: i % 11 === 0 ? "unknown" : "floor" },
    }));
    const options = {
      layoutType: "cave",
      originX: -3,
      originY: -2,
      columns: 10,
      rows: 6,
      omitDecals: true,
    };
    const render = (seed) => {
      ctx.clearRect(0, 0, 160, 96);
      art.renderTerrain(ctx, world, { ...options, seed });
      return Array.from(ctx.getImageData(0, 0, 160, 96).data);
    };
    const first = render(314159),
      second = render(42),
      repeat = render(314159);
    // More than the atlas capacity, then revisit the original negative coordinates.
    const many = Array.from({ length: 2200 }, (_, i) => ({
      x: i % 80,
      y: Math.floor(i / 80),
      terrain: { type: "floor" },
    }));
    c.width = 1280;
    c.height = 448;
    art.renderTerrain(ctx, many, {
      ...options,
      seed: 314159,
      originX: 0,
      originY: 0,
      columns: 80,
      rows: 28,
    });
    c.width = 160;
    c.height = 96;
    return { first, second, repeat, evicted: render(314159) };
  });
  const hash = (data) =>
    createHash("sha256").update(Buffer.from(data)).digest("hex");
  assert.equal(
    hash(result.first),
    "1e304615fac3670aca358f0cda555125c5bb68d97045f727b4a2e6871d2ea965",
  );
  assert.equal(
    hash(result.second),
    "c294b67ab99a2c622f21fccb2bb6ac7d18a751bb1d763c68f5dcdf7ec4ae6831",
  );
  assert.deepEqual(result.repeat, result.first);
  assert.deepEqual(result.evicted, result.first);
});

test("retained chunks preserve whole-scene masonry, cutaways, doors and torch frames without camera repaint", async (t) => {
  const page = await fixture(t);
  await page.evaluate(() => {
    const assert = (ok, message) => {
      if (!ok) throw Error(message);
    };
    const surface = document.createElement("canvas");
    document.body.append(surface);
    const scene = new art.RetainedScene(surface),
      terrain = new art.TerrainScene(document);
    const world = [];
    for (let y = 1; y < 16; y++)
      for (let x = 1; x < 32; x++)
        world.push({
          x,
          y,
          visible: true,
          terrain: {
            type:
              x === 1 || x === 31 || y === 1 || y === 15 || x === 16
                ? "wall"
                : "floor",
          },
        });
    world.find((c) => c.x === 16 && c.y === 8).terrain = {
      type: "closedDoor",
      orientation: "vertical",
    };
    const compare = (layoutType, readableCells) => {
      const options = { seed: 314159, layoutType, readableCells };
      scene.reconcile(terrain.prepare(world, options, true));
      for (let frame = 0; frame < 3; frame++) {
        const reference = document.createElement("canvas");
        reference.width = 640;
        reference.height = 384;
        art.renderTerrain(reference.getContext("2d"), world, {
          ...options,
          originX: -4,
          originY: -4,
          columns: 40,
          rows: 24,
          ambienceTimeMs: frame * 420,
        });
        const assembled = document.createElement("canvas");
        assembled.width = 640;
        assembled.height = 384;
        const c = assembled.getContext("2d");
        for (const node of scene.camera.querySelectorAll("[data-sprite]")) {
          const source = node.querySelector("canvas"),
            transform = new DOMMatrix(node.style.transform);
          const width = parseFloat(node.style.width),
            height = parseFloat(node.style.height);
          c.drawImage(
            source,
            source.width > width ? frame * width : 0,
            0,
            width,
            height,
            transform.e + 64,
            transform.f + 64,
            width,
            height,
          );
        }
        const actual = c.getImageData(0, 0, 640, 384).data,
          expected = reference
            .getContext("2d")
            .getImageData(0, 0, 640, 384).data;
        const bad = actual.findIndex((v, i) => v !== expected[i]);
        assert(
          bad === -1,
          `${layoutType} frame ${frame} differs at pixel ${Math.floor(bad / 4) % 640},${Math.floor(bad / 2560)}`,
        );
      }
    };
    compare("dungeon", []);
    compare("cave", []);
    compare("dungeon", [{ x: 15, y: 8, rise: 16 }]);
    world.find((c) => c.x === 16 && c.y === 8).terrain.type = "openDoor";
    compare("dungeon", [{ x: 15, y: 8, rise: 16 }]);
    const before = scene.stats.rasterizations;
    scene.reconcile(
      terrain.prepare(
        [...world].reverse(),
        {
          seed: 314159,
          layoutType: "dungeon",
          readableCells: [{ x: 15, y: 8, rise: 16 }],
        },
        true,
      ),
    );
    for (let i = 0; i < 100; i++) scene.moveCamera(-i, i, 1 + i / 100);
    assert(
      scene.stats.rasterizations === before,
      "camera or input order caused a terrain repaint",
    );
    scene.destroy();
    assert(!document.querySelector("[data-scene]"), "destroy leaked a scene");
  });
});

test("camera transforms and sprite playback run without raster work; live hit testing follows the compositor", async (t) => {
  const page = await fixture(t);
  await page.evaluate(async () => {
    const assert = (ok, message) => {
      if (!ok) throw Error(message);
    };
    const surface = document.createElement("canvas");
    document.body.append(surface);
    const scene = new art.RetainedScene(surface);
    scene.moveCamera(10, 20, 2);
    const spec = {
      key: "actor:test",
      signature: "red",
      x: 16,
      y: 32,
      width: 16,
      height: 16,
      z: 100,
      frames: 2,
      period: 100,
      target: { x: 1, y: 2 },
      paint: (c, frame) => {
        c.fillStyle = frame ? "blue" : "red";
        c.fillRect(4, 4, 8, 8);
      },
    };
    scene.reconcile([spec]);
    const before = scene.stats.rasterizations;
    const sprite = scene.camera.querySelector("[data-sprite]"),
      strip = sprite.querySelector("canvas");
    const animation = strip.getAnimations()[0];
    animation.pause();
    animation.currentTime = 150;
    assert(
      new DOMMatrix(getComputedStyle(strip).transform).e === -16,
      "sprite strip did not advance",
    );
    scene.moveCamera(110, 20, 2, 200);
    const camera = scene.camera.getAnimations()[0];
    camera.pause();
    camera.currentTime = 100;
    const box = scene.element.getBoundingClientRect();
    const matrix = new DOMMatrix(getComputedStyle(scene.camera).transform);
    const x = box.x + matrix.e + (16 + 6) * 2,
      y = box.y + matrix.f + (32 + 6) * 2;
    assert(
      scene.pick(x, y)?.x === 1,
      "animated camera picking missed an opaque sprite",
    );
    assert(
      !scene.pick(x - 10, y - 10),
      "transparent sprite padding stole a click",
    );
    assert(
      scene.stats.rasterizations === before,
      "compositor animation repainted a sprite",
    );
    scene.setMotion(false);
    assert(
      !scene.camera.getAnimations().length,
      "reduced motion retained camera animation",
    );
    scene.destroy();
  });
});

test("1,200 replay updates do not accumulate terrain work or scene nodes", async (t) => {
  const page = await fixture(t);
  const javascript = execFileSync(
    "bun",
    ["build", join(root, "src/map.ts"), "--target=browser"],
    { encoding: "utf8" },
  );
  const images = Object.fromEntries(
    await Promise.all(
      (await readdir(join(root, "public/art")))
        .filter((file) => file.endsWith(".png"))
        .map(async (file) => [
          file.slice(0, -4),
          "data:image/png;base64," +
            (await readFile(join(root, "public/art", file))).toString("base64"),
        ]),
    ),
  );
  const result = await page.evaluate(
    async ({ javascript, images }) => {
      const { DungeonMap, loadArt } = await import(
        URL.createObjectURL(new Blob([javascript], { type: "text/javascript" }))
      );
      await loadArt(images);
      const host = document.createElement("div");
      host.style.cssText = "position:relative;width:1280px;height:800px";
      document.body.append(host);
      const canvas = document.createElement("canvas");
      host.append(canvas);
      const map = new DungeonMap(canvas, () => {});
      const world = Array.from({ length: 400 }, (_, i) => ({
        x: i % 20,
        y: Math.floor(i / 20),
        visible: true,
        terrain: { type: "floor" },
      }));
      // Renderer-only playback fixture. No engine request, session, journal or save.
      const observation = (turn) => ({
        turn,
        location: { id: "stress" },
        you: { x: 10 + (turn % 2), y: 10 },
        world,
      });
      map.update(observation(0), "valkyrie", "stress");
      const initial = { ...map.scene.stats },
        nodes = map.scene.sprites.size;
      for (let turn = 1; turn <= 1200; turn++)
        map.update(observation(turn), "valkyrie", "stress");
      const result = {
        additionalRasterizations:
          map.scene.stats.rasterizations - initial.rasterizations,
        nodesBefore: nodes,
        nodesAfter: map.scene.sprites.size,
        terrainChunks: map.terrainSprites.length,
        animationFrames: map.animation,
      };
      map.destroy();
      host.remove();
      return result;
    },
    { javascript, images },
  );
  assert.equal(result.additionalRasterizations, 0, JSON.stringify(result));
  assert.equal(result.nodesAfter, result.nodesBefore);
  assert.ok(result.terrainChunks < 20, JSON.stringify(result));
});
