import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
// Deliberate finished-project selection, not an inventory auto-generated from
// whatever happens to be in a private asset library or export directory.
const expected = {
  "bat.png": [16, 16],
  "cat.png": [16, 16],
  "dog.png": [16, 16],
  "explorer-motion.png": [384, 64],
  "explorer.png": [16, 32],
  "scholar-motion.png": [384, 64],
  "scholar.png": [16, 32],
};
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

test("public art contains only the seven client-sized PNG exports", async () => {
  assert.deepEqual(await files(`${root}/public/art`), Object.keys(expected));
  for (const [file, size] of Object.entries(expected)) {
    const png = await readFile(`${root}/public/art/${file}`);
    assert.deepEqual(png.subarray(0, 8), Buffer.from("89504e470d0a1a0a", "hex"), file);
    assert.equal(png.toString("ascii", 12, 16), "IHDR", file);
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], size, file);
    // No copied exporter metadata or private workstation paths in PNG chunks.
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

test("art source keeps project provenance and layouts, not raw skill templates", async () => {
  assert.deepEqual(await files(`${root}/art`), [
    "ATTRIBUTION.md",
    "LimeZu-LICENSE.txt",
    "README.md",
    "layouts/geometry.txt",
    "layouts/rooms.txt",
    "layouts/waterworks.txt",
    "recipe.json",
  ]);
  const recipe = JSON.parse(await readFile(`${root}/art/recipe.json`, "utf8"));
  assert.deepEqual(recipe.assets.map((asset) => asset.file).sort(), Object.keys(expected));
  for (const asset of recipe.assets) {
    assert.deepEqual(asset.size, expected[asset.file], asset.file);
    assert.ok(asset.source && asset.use, `${asset.file}: source and actual use required`);
    assert.ok(asset.export && (asset.export.asset || asset.export.template), asset.file);
    for (const key of Object.keys(asset))
      assert.ok(["file", "source", "export", "use", "size", "credit"].includes(key), key);
    for (const key of Object.keys(asset.export))
      assert.ok(["asset", "rect", "scale", "template", "name", "color"].includes(key), key);
  }
});
