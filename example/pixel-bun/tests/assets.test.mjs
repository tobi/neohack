import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
// Explicit approved selections, never discovered from an export directory or
// private asset catalog. New roles/sources require a deliberate review here.
const prototypes = [
  "archeologist", "barbarian", "caveman", "healer", "knight",
  "monk", "priest", "ranger", "rogue", "samurai", "tourist", "valkyrie", "wizard",
];
const animals = ["bat", "cat", "dog"];
const expected = Object.fromEntries([
  ...prototypes.flatMap((role) => [
    [`${role}.png`, [16, 32]],
    [`${role}-motion.png`, [384, 64]],
  ]),
  ...animals.map((animal) => [`${animal}.png`, [16, 16]]),
]);
const runtimeFiles = Object.keys(expected).sort();
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
    // Runtime exports carry only image data.
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

test("art sources retain portable recipes, not raw templates or retired studies", async () => {
  assert.deepEqual(await files(`${root}/art`), [
    "ATTRIBUTION.md", "LimeZu-LICENSE.txt", "README.md", "classes.json",
    "layouts/geometry.txt", "layouts/rooms.txt", "layouts/waterworks.txt",
    "recipe.json", "social/README.md", "social/composition.html",
  ].sort());
});

test("portable export recipes cover every runtime file and retain exact source parameters", async () => {
  const recipe = await json("art/recipe.json");
  assert.deepEqual(recipe.assets.map((asset) => asset.file).sort(), runtimeFiles);
  assert.deepEqual(recipe.animation.directions, directions);
  assert.deepEqual(recipe.animation.fps, fps);
  assert.equal(recipe.animation.framesPerDirection, 6);
  assert.deepEqual(recipe.animation.rows, { idle: 0, walk: 32 });
  assert.deepEqual(recipe.animation.frameSize, [16, 32]);
  assert.deepEqual(recipe.animation.pivot, [8, 32]);
  for (const asset of recipe.assets) {
    assert.deepEqual(asset.size, expected[asset.file], asset.file);
    assert.ok(asset.source && asset.use, `${asset.file}: source and actual use required`);
    allowedKeys(asset, ["file", "source", "recipe", "export", "use", "size", "credit"], asset.file);
    const prototype = prototypes.find((role) => [role + ".png", role + "-motion.png"].includes(asset.file));
    if (prototype) {
      assert.match(asset.source, /LimeZu/);
      assert.equal(asset.credit, "Modern Interiors by LimeZu");
      assert.equal(asset.recipe, `classes.json#${prototype}`);
      assert.deepEqual(asset.export, asset.file.endsWith("-motion.png")
        ? { rect: [0, 32, 384, 64], scale: 1 } : ["valkyrie", "wizard"].includes(prototype)
          ? { rect: [48, 0, 16, 32], scale: 1 } : { output: "avatar" });
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

test("character recipes contain only selected asset and layer identifiers, not vendor pixels", async () => {
  const classes = await json("art/classes.json");
  allowedKeys(classes, ["version", "source", "characters"], "classes");
  assert.match(classes.source, /LimeZu/);
  assert.deepEqual(classes.characters.map((entry) => entry.id).sort(), prototypes);
  for (const entry of classes.characters) {
    if (["valkyrie", "wizard"].includes(entry.id)) {
      allowedKeys(entry, ["id", "asset"], entry.id);
      assert.equal(entry.asset, entry.id === "valkyrie" ? "modern-premade-character-03" : "modern-premade-character-02");
      continue;
    }
    allowedKeys(entry, ["id", "body", "eyes", "outfit", "hair", "accessories"], entry.id);
    for (const key of ["body", "eyes", "outfit"])
      assert.match(entry[key], new RegExp(`^generator-${key}-[a-z0-9-]+$`), `${entry.id}: ${key}`);
    if (entry.hair) assert.match(entry.hair, /^generator-hairstyle-[a-z0-9-]+$/);
    assert.ok(Array.isArray(entry.accessories), entry.id);
    for (const accessory of entry.accessories)
      assert.match(accessory, /^generator-accessory-[a-z0-9-]+$/);
  }
});

test("package art commands retain only the supported builders", async () => {
  const metadata = await json("package.json");
  assert.deepEqual(
    Object.fromEntries(Object.entries(metadata.scripts).filter(([name]) => name.startsWith("art:"))),
    {
      "art:render": "bun scripts/render-dungeon.ts",
      "art:characters": "node scripts/build-characters.mjs",
    },
  );
  for (const [name, command] of Object.entries(metadata.scripts))
    if (name.startsWith("art:"))
      assert.ok((await readFile(`${root}/${command.split(" ")[1]}`, "utf8")).trim(), name);
});
