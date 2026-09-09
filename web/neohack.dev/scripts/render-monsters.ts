#!/usr/bin/env bun
/** Export and verify the runtime family atlas without exposing a bestiary. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { chromium } from "playwright-core";
import {
  creatureBases,
  creaturePalettes,
  creatureRecipe,
  creaturePixels,
  familyPixels,
} from "../src/creature-families";
import { monsterAppearances } from "../src/monster-appearances";
import { monsterRoster } from "./monster-roster.mjs";
const root = resolve(import.meta.dir, ".."),
  out = join(root, "test-results/art/monsters");
await mkdir(out, { recursive: true });
const roster = monsterRoster();
const missing = new Set(
  roster.rows
    .flatMap((row) => row.aliases)
    .filter((name) => !creatureRecipe(name)),
);
assert.equal(missing.size, 3);
for (const name of missing)
  assert.ok(
    roster.rows.filter((row) => row.aliases.includes(name)).length > 1,
    "Only ambiguous names may lack art",
  );
for (const [name, recipe] of Object.entries(monsterAppearances)) {
  const art = familyPixels(recipe);
  assert.ok(art.pixels.length <= 26);
  assert.ok(
    art.pixels.every(
      (row) => row.length === art.pixels[0]!.length && /^[.#hos]+$/.test(row),
    ),
    name,
  );
  assert.deepEqual(
    Object.keys(recipe).filter(
      (k) => !["family", "size", "palette", "asset"].includes(k),
    ),
    [],
  );
}
for (const name of ["newt", "lichen", "sewer rat"])
  assert.ok(creaturePixels(name)!.pixels.length <= 6);
assert.equal(creatureRecipe("__proto__"), undefined);
assert.equal(creatureRecipe(undefined), undefined);
const entries = Object.keys(creatureBases).flatMap((family) =>
  ["small", "medium", "large"].map((size) => ({
    family,
    size,
    palette: "earth",
    art: familyPixels({
      family,
      size: size as "small" | "medium" | "large",
      palette: "earth",
    }),
  })),
);
assert.ok(
  familyPixels({ family: "goblin", size: "large", palette: "clay" }).pixels
    .length >
    familyPixels({ family: "goblin", size: "small", palette: "sage" }).pixels
      .length,
);
const bundle = await Bun.build({
  entrypoints: [join(root, "src/symbol-art.ts")],
  target: "browser",
  format: "esm",
});
assert.ok(bundle.success);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  headless: true,
  chromiumSandbox: true,
});
try {
  const page = await browser.newPage();
  await page.addScriptTag({
    type: "module",
    content:
      (await bundle.outputs[0]!.text()).replace(/export \{[\s\S]*$/, "") +
      "\nwindow.monsterArt={creatureArtUrl,drawCreatureArt,drawUnknownCreature,drawCreatureQuestion};",
  });
  await page.waitForFunction(() => Boolean((window as any).monsterArt));
  const paletteEntries = Object.keys(creaturePalettes).map((palette) => ({
    palette,
    art: familyPixels({ family: "goblin", size: "medium", palette }),
  }));
  const result = await page.evaluate(
    ({ entries, paletteEntries }) => {
      const api = (window as any).monsterArt;
      const unknown = api.creatureArtUrl(undefined, "d");
      for (const mark of ["D", "@", "f", "B", "x"])
        if (api.creatureArtUrl(undefined, mark) !== unknown)
          throw Error("Unknown portrait leaks glyph");
      for (const name of ["__proto__", "unpictured creature"])
        if (api.creatureArtUrl(name, "D") !== unknown)
          throw Error("Fallback is not neutral");
      if (api.creatureArtUrl("dog", "D") !== "/art/dog.png")
        throw Error("Companion regression");
      const sheet = document.createElement("canvas");
      sheet.width = 9 * 32;
      sheet.height = Math.ceil(entries.length / 9) * 32;
      const c = sheet.getContext("2d")!;
      entries.forEach(({ art }, i) => {
        const left = (i % 9) * 32 + Math.floor((32 - art.pixels[0].length) / 2),
          top = Math.floor(i / 9) * 32 + 31 - art.pixels.length;
        const palette: any = {
          "#": "#1c2729",
          h: art.highlight,
          o: art.body,
          s: art.shade,
        };
        art.pixels.forEach((row: string, y: number) =>
          [...row].forEach((p, x) => {
            if (p !== ".") {
              c.fillStyle = palette[p];
              c.fillRect(left + x, top + y, 1, 1);
            }
          }),
        );
      });
      const swatches = document.createElement("canvas");
      swatches.width = 9 * 32;
      swatches.height = 32;
      const sc = swatches.getContext("2d")!;
      paletteEntries.forEach(({ art }, i) => {
        const colors: any = {
          "#": "#1c2729",
          h: art.highlight,
          o: art.body,
          s: art.shade,
        };
        art.pixels.forEach((row: string, y: number) =>
          [...row].forEach((p, x) => {
            if (p !== ".") {
              sc.fillStyle = colors[p];
              sc.fillRect(
                i * 32 + Math.floor((32 - row.length) / 2) + x,
                31 - art.pixels.length + y,
                1,
                1,
              );
            }
          }),
        );
      });
      return {
        sheet: sheet.toDataURL().split(",")[1],
        palettes: swatches.toDataURL().split(",")[1],
        unknown,
      };
    },
    { entries, paletteEntries },
  );
  await writeFile(
    join(out, "palettes.png"),
    Buffer.from(result.palettes!, "base64"),
  );
  await writeFile(
    join(out, "sprites.png"),
    Buffer.from(result.sheet!, "base64"),
  );
  await writeFile(
    join(out, "unknown.png"),
    Buffer.from(result.unknown.split(",")[1], "base64"),
  );
  await writeFile(
    join(out, "sprites.json"),
    JSON.stringify(
      {
        cell: [32, 32],
        columns: 9,
        anchor: [16, 31],
        sprites: entries.map(({ family, size, palette }, i) => ({
          family,
          size,
          palette,
          x: (i % 9) * 32,
          y: Math.floor(i / 9) * 32,
          width: 32,
          height: 32,
        })),
      },
      null,
      2,
    ),
  );
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Creature artwork proof</title><style>body{margin:32px;background:#182421;color:#e6dfcb;font:16px system-ui;max-width:1160px}h1{font-size:30px}p{max-width:780px;line-height:1.6}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}img{image-rendering:pixelated}code{color:#dcbe83}a{color:#c4dba8}a:focus-visible{outline:2px solid #dcbe83;outline-offset:4px}</style><h1>Creature artwork · perception first</h1><p>383 source definitions audited; 405 unambiguous appearance names mapped to 45 reusable shapes. Three names shared by different forms keep the uncertain illustration. The game selects art only from the appearance the engine discloses.</p><p><img src="unknown.png" width="64" height="64" alt="Neutral cloud with question mark"> Unknown creatures always use this same cloud and question mark. No size or color clues. This authoring proof shows shape families, without a species catalogue or hidden mechanics.</p><p>Each row shows <code>small · medium · large</code>, at 2× inspection scale. Palette names describe paint, never strength. Existing tiny encounters and companion portraits keep their approved artwork.</p><p>Runtime recipes use <code>family.size.palette</code>. The exported transparent atlas has 135 variants in 32×32 cells, anchored at (16,31). Native map drawings share a fixed 16px interaction tile.</p><p><img src="palettes.png" width="576" height="64" style="max-width:100%" alt="Same base shape in nine muted palettes"><br>earth · sage · clay · mist · slate · ivory · ink · amber · plum</p><p><a href="map.png">Live map comparison</a> · <a href="sprites.png">Transparent sprite sheet</a> · <a href="sprites.json">Atlas coordinates</a></p><main></main><script type="module">import{LitElement,html,css}from'https://esm.sh/lit@3';const families=${JSON.stringify(Object.keys(creatureBases))};class CreatureCard extends LitElement{static properties={index:{type:Number},family:{type:String}};static styles=css\`:host{display:block;background:#293832;padding:14px;border-radius:8px}h2{font-size:15px;margin:0 0 8px}.sprite{display:inline-block;width:64px;height:64px;background-image:url('./sprites.png');background-size:576px 960px;image-rendering:pixelated}small{display:block;color:#b5c0ae}\`;render(){return html\`<h2>\${this.family}</h2>\${[0,1,2].map(n=>{const i=this.index*3+n;return html\`<span class="sprite" style="background-position:\${-(i%9)*64}px \${-Math.floor(i/9)*64}px"></span>\`})}<small>small · medium · large</small>\`}}customElements.define('creature-card',CreatureCard);families.forEach((family,index)=>{const card=document.createElement('creature-card');card.family=family;card.index=index;document.querySelector('main').append(card)});</script><p>Source: pinned engine/include/monsters.h; source SHA-256 ${roster.sha256}. Only names and broad drawing groups enter the authoring pipeline. No engine color, size, attack, resistance, spawn or level data enters the runtime recipes.</p></html>`;
  await writeFile(join(out, "report.html"), html);
  // Local screenshot uses the exact atlas, independent of external report modules.
  await page.setContent(
    '<body style="background:#64776b;margin:20px"><img style="image-rendering:pixelated;width:864px" src="data:image/png;base64,' +
      result.sheet +
      '"></body>',
  );
  await page.screenshot({ path: join(out, "preview.png"), fullPage: true });
  console.log(
    `Verified ${roster.rows.length} definitions, ${Object.keys(monsterAppearances).length} appearances, ${entries.length} atlas variants; neutral unknown portraits and early scales pass.`,
  );
} finally {
  await browser.close();
}
