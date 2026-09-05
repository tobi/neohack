import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
// Explicit approved selections, never discovered from an export directory or
// private asset catalog. New roles/sources require a deliberate review here.
const prototypes = [
  "archeologist", "barbarian", "caveman", "healer", "knight",
  "monk", "priest", "rogue", "samurai", "tourist",
];
const originals = ["valkyrie", "wizard", "ranger"];
const animals = ["bat", "cat", "dog"];
const expected = Object.fromEntries([
  ...prototypes.flatMap((role) => [
    [`${role}.png`, [16, 32]],
    [`${role}-motion.png`, [384, 64]],
  ]),
  ...originals.flatMap((role) => [
    [`${role}-original.png`, [24, 32]],
    [`${role}-original-motion.png`, [576, 64]],
  ]),
  ...animals.map((animal) => [`${animal}.png`, [16, 16]]),
]);
const runtimeFiles = Object.keys(expected).sort();
const originalSources = [
  "README.md",
  ...originals.flatMap((role) => [`${role}-prompt.txt`, `${role}-source.png`, `${role}.json`]),
].sort();
const directions = ["right", "up", "left", "down"];
const fps = { idle: 6, walk: 10 };
const json = async (path) => JSON.parse(await readFile(`${root}/${path}`, "utf8"));
async function files(directory, prefix = "") {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert.ok(
      entry.isFile() || entry.isDirectory(),
      `No linked or special art inputs: ${prefix}${entry.name}`,
    );
    const path = prefix + entry.name;
    if (entry.isDirectory())
      paths.push(...(await files(`${directory}/${entry.name}`, path + "/")));
    else paths.push(path);
  }
  return paths.sort();
}
function pngSize(png, file) {
  assert.deepEqual(png.subarray(0, 8), Buffer.from("89504e470d0a1a0a", "hex"), file);
  assert.equal(png.toString("ascii", 12, 16), "IHDR", file);
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}
function allowedKeys(value, allowed, label) {
  for (const key of Object.keys(value))
    assert.ok(allowed.includes(key), `${label}: unexpected ${key}`);
}

test("public art contains exactly 29 selected runtime PNGs, without metadata sidecars", async () => {
  assert.equal(runtimeFiles.length, 29);
  assert.deepEqual(await files(`${root}/public/art`), runtimeFiles);
  for (const [file, size] of Object.entries(expected)) {
    const png = await readFile(`${root}/public/art/${file}`);
    assert.deepEqual(pngSize(png, file), size, file);
    // Runtime exports carry only image data. Untouched original source images
    // have their own provenance metadata and are checked separately by hash.
    let offset = 8;
    const chunks = [];
    while (offset < png.length) {
      assert.ok(offset + 12 <= png.length, `${file}: truncated chunk header`);
      const length = png.readUInt32BE(offset);
      const type = png.toString("ascii", offset + 4, offset + 8);
      assert.ok(["IHDR", "IDAT", "IEND"].includes(type), `${file}: unexpected ${type}`);
      offset += 12 + length;
      assert.ok(offset <= png.length, `${file}: truncated chunk payload`);
      chunks.push(type);
    }
    assert.equal(chunks.at(-1), "IEND", file);
    assert.ok(chunks.includes("IDAT"), file);
  }
});

test("art sources retain ten original project inputs, not raw skill templates or old studies", async () => {
  assert.equal(originalSources.length, 10);
  assert.deepEqual(await files(`${root}/art/original-heroes`), originalSources);
  assert.deepEqual(await files(`${root}/art`), [
    "ATTRIBUTION.md", "LimeZu-LICENSE.txt", "README.md", "classes.json",
    "layouts/geometry.txt", "layouts/rooms.txt", "layouts/waterworks.txt",
    ...originalSources.map((file) => `original-heroes/${file}`),
    "recipe.json",
  ].sort());
});

test("portable export recipes cover every runtime file and retain exact source parameters", async () => {
  const recipe = await json("art/recipe.json");
  assert.deepEqual(recipe.assets.map((asset) => asset.file).sort(), runtimeFiles);
  assert.deepEqual(recipe.animation.directions, directions);
  assert.deepEqual(recipe.animation.fps, fps);
  assert.equal(recipe.animation.framesPerDirection, 6);
  assert.deepEqual(recipe.animation.rows, { idle: 0, walk: 32 });
  assert.deepEqual(recipe.animation.prototype.frameSize, [16, 32]);
  assert.deepEqual(recipe.animation.prototype.pivot, [8, 32]);
  assert.deepEqual(recipe.animation.original.frameSize, [24, 32]);
  assert.deepEqual(recipe.animation.original.pivot, [12, 32]);
  for (const asset of recipe.assets) {
    assert.deepEqual(asset.size, expected[asset.file], asset.file);
    assert.ok(asset.source && asset.use, `${asset.file}: source and actual use required`);
    allowedKeys(asset, ["file", "source", "recipe", "export", "use", "size", "credit"], asset.file);
    const prototype = prototypes.find((role) => [role + ".png", role + "-motion.png"].includes(asset.file));
    const original = originals.find((role) => [role + "-original.png", role + "-original-motion.png"].includes(asset.file));
    if (prototype) {
      assert.match(asset.source, /LimeZu/);
      assert.equal(asset.credit, "Modern Interiors by LimeZu");
      assert.equal(asset.recipe, `classes.json#${prototype}`);
      assert.deepEqual(asset.export, asset.file.endsWith("-motion.png")
        ? { rect: [0, 32, 384, 64], scale: 1 } : { output: "avatar" });
    } else if (original) {
      assert.match(asset.source, /Original built-in image_gen/);
      assert.equal(asset.recipe, `original-heroes/${original}.json`);
      assert.deepEqual(asset.export, asset.file.endsWith("-motion.png")
        ? { output: "packed-idle-walk" } : { row: 3, col: 0 });
    } else {
      const animal = asset.file.replace(".png", "");
      assert.ok(animals.includes(animal), asset.file);
      assert.equal(asset.recipe, undefined, "Do not restore a copied skill template JSON");
      const exports = {
        dog: { template: "dog", name: "Companion", color: "#c79b67" },
        cat: { template: "cat", name: "Feline" },
        bat: { template: "bat", name: "Bat" },
      };
      assert.deepEqual(asset.export, exports[animal]);
    }
  }
});

test("prototype recipes contain only the ten selected layer identifiers, not vendor pixels", async () => {
  const classes = await json("art/classes.json");
  allowedKeys(classes, ["version", "source", "characters"], "classes");
  assert.match(classes.source, /LimeZu/);
  assert.deepEqual(classes.characters.map((entry) => entry.id).sort(), prototypes);
  for (const entry of classes.characters) {
    allowedKeys(entry, ["id", "body", "eyes", "outfit", "hair", "accessories"], entry.id);
    for (const key of ["body", "eyes", "outfit"])
      assert.match(entry[key], new RegExp(`^generator-${key}-[a-z0-9-]+$`), `${entry.id}: ${key}`);
    if (entry.hair) assert.match(entry.hair, /^generator-hairstyle-[a-z0-9-]+$/);
    assert.ok(Array.isArray(entry.accessories), entry.id);
    for (const accessory of entry.accessories)
      assert.match(accessory, /^generator-accessory-[a-z0-9-]+$/);
  }
});

test("package art commands retain supported builders and the separate original import", async () => {
  const metadata = await json("package.json");
  assert.deepEqual(
    Object.fromEntries(Object.entries(metadata.scripts).filter(([name]) => name.startsWith("art:"))),
    {
      "art:render": "bun scripts/render-dungeon.ts",
      "art:characters": "node scripts/build-characters.mjs",
      "art:original": "node scripts/build-original-heroes.mjs",
      "art:original:import": "node scripts/import-original-heroes.mjs",
    },
  );
  for (const [name, command] of Object.entries(metadata.scripts))
    if (name.startsWith("art:"))
      assert.ok((await readFile(`${root}/${command.split(" ")[1]}`, "utf8")).trim(), name);
});

test("original hero recipes preserve their prompts, source hashes and editable 24x32 frames", async () => {
  for (const role of originals) {
    const recipe = await json(`art/original-heroes/${role}.json`);
    assert.equal(recipe.role, role);
    assert.equal(recipe.source, `${role}-source.png`);
    assert.equal(recipe.generation.tool, "built-in image_gen");
    assert.equal(recipe.generation.prompt, `${role}-prompt.txt`);
    assert.equal(recipe.generation.model, "not reported by tool");
    assert.equal(recipe.generation.seed, null);
    const source = await readFile(`${root}/art/original-heroes/${recipe.source}`);
    assert.equal(createHash("sha256").update(source).digest("hex"), recipe.sourceSha256, role);
    assert.deepEqual(pngSize(source, recipe.source), recipe.sourceSize, role);
    assert.ok((await readFile(`${root}/art/original-heroes/${recipe.generation.prompt}`, "utf8")).trim(), role);
    assert.deepEqual(recipe.frameSize, [24, 32]);
    assert.deepEqual(recipe.pivot, [12, 32]);
    assert.deepEqual(recipe.directions, directions);
    assert.deepEqual(recipe.fps, fps);
    assert.equal(Object.keys(recipe.palette).length, 27, role);
    for (const color of Object.values(recipe.palette)) assert.match(color, /^#[0-9a-f]{6}$/i);
    assert.ok(recipe.normalization, role);
    assert.equal(recipe.frames.length, 48, role);
    const positions = new Set();
    for (const frame of recipe.frames) {
      assert.ok(Number.isInteger(frame.row) && frame.row >= 0 && frame.row < 8, role);
      assert.ok(Number.isInteger(frame.col) && frame.col >= 0 && frame.col < 6, role);
      positions.add(`${frame.row}:${frame.col}`);
      assert.equal(frame.pixels.length, 32, role);
      for (const line of frame.pixels) {
        assert.equal(line.length, 24, role);
        for (const token of line) assert.ok(token === "." || recipe.palette[token], `${role}: ${token}`);
      }
      const [x, y, width, height] = frame.sourceRect;
      assert.equal(frame.sourceRect.length, 4, role);
      assert.ok(frame.sourceRect.every(Number.isInteger), role);
      assert.ok(x >= 0 && y >= 0 && width > 0 && height > 0, role);
      assert.ok(x + width <= recipe.sourceSize[0] && y + height <= recipe.sourceSize[1], role);
      assert.equal(frame.registrationOffset.length, 2, role);
      assert.ok(frame.registrationOffset.every(Number.isInteger), role);
    }
    assert.equal(positions.size, 48, role);
  }
});
