import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
const root = resolve(import.meta.dirname, '..');
test('inventory illustrations distinguish perceived shapes and ignore nicknames', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'neohack-item-art-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  execFileSync('bun', ['build', 'src/symbol-art.ts', '--outfile', join(temp, 'art.js')], {cwd: root});
  const source = await readFile(join(temp, 'art.js'), 'utf8');
  const browser = await chromium.launch({executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true, chromiumSandbox: true});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport: {width: 540, height: 760}, deviceScaleFactor: 1});
  const result = await page.evaluate(async source => {
    const { inventoryArt, drawItemArt } = await import(URL.createObjectURL(new Blob([source], {type: 'text/javascript'})));
    document.body.style.cssText = 'margin:0;padding:24px;background:#192421;color:#e5dfcf;font:18px system-ui';
    const samples = [
      ['armor', 'small shield'], ['weapon', 'mace'], ['tool', 'chest'],
      ['armor', 'riding gloves'], ['armor', 'hard shoes'], ['armor', 'plumed helmet'],
      ['armor', 'ornamental cope'], ['armor', 'leather armor'],
      ['weapon', 'long sword'], ['weapon', 'dagger'], ['weapon', 'curved sword'],
      ['weapon', 'axe'], ['weapon', 'double-headed axe'], ['weapon', 'spear'],
      ['weapon', 'vulgar polearm'], ['weapon', 'bow'], ['weapon', 'crossbow'],
      ['weapon', 'crossbow bolt'], ['weapon', 'war hammer'], ['weapon', 'club'],
      ['weapon', 'staff'], ['weapon', 'bullwhip'], ['object', 'statue'],
    ];
    const urls = [];
    for (const [category, appearance] of samples) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:20px;padding:12px;border-bottom:1px solid #465143';
      const url = inventoryArt({category, known:{appearance}}); urls.push(url);
      for (const scale of [1, 3]) {
        const img = document.createElement('img');img.src=url;img.width=img.height=16*scale;img.style.imageRendering='pixelated';row.append(img);
      }
      row.append(document.createTextNode(appearance));document.body.append(row);
    }
    const plain=inventoryArt({category:'tool'});
    const statues = ['human','dog','housecat','raven','python','red dragon'].map(depictedCreature=>({category:'object',known:{appearance:'statue',depictedCreature}}));
    const statueImages = statues.map(inventoryArt);
    const worldParity = [...statues,...samples.map(([category,appearance])=>({category,known:{appearance}}))].every(item=>{
      const canvas=document.createElement('canvas');canvas.width=canvas.height=16;
      return drawItemArt(canvas.getContext('2d'),item) && canvas.toDataURL()===inventoryArt(item);
    });
    return {urls, nicknameSafe: plain===inventoryArt({category:'tool',label:'a chest named mace'}),
      statueImages, worldParity,
      missingSafe: inventoryArt({category:'armor'})!==urls[0],
      cacheSafe: inventoryArt({category:'armor',known:{appearance:'small shield'}})===urls[0],
      identitySafe: inventoryArt({category:'weapon',known:{identity:'long sword'},label:'long sword'})===inventoryArt({category:'weapon'}),
      statueSafe: inventoryArt({category:'object',known:{appearance:'statue'},label:'statue of a dragon'})===urls.at(-1)};
  }, source);
  assert.equal(new Set(result.urls).size, result.urls.length);
  assert.equal(new Set(result.statueImages).size,6);
  assert.ok(result.worldParity);
  assert.ok(result.nicknameSafe && result.missingSafe && result.cacheSafe && result.identitySafe && result.statueSafe);
  await mkdir(join(root, 'test-results'), {recursive:true});
  await page.screenshot({path:join(root,'test-results/item-art.png')});
});
