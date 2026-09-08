#!/usr/bin/env bun
/** Export the exact runtime pixel grids; no image model or private art library needed. */
import { chromium } from 'playwright-core';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { equipmentPixels, equipmentPalette } from '../src/equipment-pixels';
import { itemSilhouette } from '../src/item-art';
const root = resolve(import.meta.dir, '..');
const out = join(root, 'test-results/art/equipment');
await mkdir(out, {recursive:true});
const source = await readFile(join(root, '../../lib/neonethack/engine/include/objects.h'), 'utf8');
const appearances = [...source.matchAll(/^(?:WEAPON|PROJECTILE|BOW)\("([^"]+)",\s*(?:"([^"]+)"|NoDes)/gm)]
  .map(m => ({name:m[1]!, appearance:m[2] ?? m[1]!, sprite:itemSilhouette('weapon', m[2] ?? m[1]!)}));
const missing = appearances.filter(a => !a.sprite);
if (missing.length) throw Error(`Unillustrated weapon appearances: ${JSON.stringify(missing)}`);
for (const [name, pixels] of Object.entries(equipmentPixels)) {
  if (pixels.length !== 16 || pixels.some(row => row.length !== 16 || [...row].some(p => p !== '.' && !equipmentPalette[p])))
    throw Error(`Invalid pixel grid: ${name}`);
}
const browser = await chromium.launch({executablePath:process.env.CHROMIUM ?? '/usr/bin/chromium', headless:true, chromiumSandbox:true});
try {
  const page = await browser.newPage({viewport:{width:1000,height:800},deviceScaleFactor:1});
  const png = await page.evaluate(({pixels,palette}) => {
    const entries = Object.entries(pixels);
    const sheet = document.createElement('canvas');sheet.width=8*16;sheet.height=Math.ceil(entries.length/8)*16;
    const c = sheet.getContext('2d')!;
    entries.forEach(([name, rows], i) => {
      rows.forEach((row,y) => [...row].forEach((p,x) => {
        if(p!=='.'){c.fillStyle=palette[p]!;c.fillRect((i%8)*16+x,Math.floor(i/8)*16+y,1,1);}
      }));
    });
    document.body.style.cssText='margin:0;padding:24px;background:#192421;color:#e5dfcf;font:14px system-ui';
    const heading=document.createElement('h1');heading.textContent='Weapons & carved stone';document.body.append(heading);
    const note=document.createElement('p');note.textContent='Native 16px and 4×. All six statue shapes select from structured perceived subjects.';document.body.append(note);
    const grid=document.createElement('div');grid.style.cssText='display:grid;grid-template-columns:repeat(6,1fr);gap:12px';document.body.append(grid);
    entries.forEach(([name],i)=>{
      const card=document.createElement('div');card.style.cssText='padding:12px;background:#29342f;min-height:94px';
      for(const scale of [1,4]){
        const tile=document.createElement('canvas');tile.width=tile.height=16;tile.style.cssText=`width:${16*scale}px;height:${16*scale}px;image-rendering:pixelated;margin-right:10px`;
        tile.getContext('2d')!.drawImage(sheet,(i%8)*16,Math.floor(i/8)*16,16,16,0,0,16,16);card.append(tile);
      }
      const label=document.createElement('div');label.textContent=name;card.append(label);grid.append(card);
    });
    return sheet.toDataURL().split(',')[1]!;
  }, {pixels:equipmentPixels,palette:equipmentPalette});
  await writeFile(join(out,'sprites.png'),Buffer.from(png,'base64'));
  await writeFile(join(out,'sprites.json'),JSON.stringify({source:'src/equipment-pixels.ts',cell:[16,16],columns:8,sprites:Object.keys(equipmentPixels).map((name,i)=>({name,x:(i%8)*16,y:Math.floor(i/8)*16,width:16,height:16,usage:'world-and-inventory'})),weapons:appearances},null,2)+'\n');
  await page.screenshot({path:join(out,'preview.png'),fullPage:true});
  console.log(`${appearances.length} weapon definitions covered; ${Object.keys(equipmentPixels).length} sprites exported to ${out}`);
} finally {await browser.close();}
