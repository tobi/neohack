import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

test('sandboxed Chromium renders disclosed door axes independently of incomplete neighbors', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'neonethack-door-art-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const bundle = join(temporary, 'renderer.js');
  await promisify(execFile)('bun', ['build', 'src/dungeon-art.ts', '--outfile', bundle], { cwd: resolve(import.meta.dirname, '..') });
  const source = await readFile(bundle, 'utf8');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true, chromiumSandbox: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const result = await page.evaluate(async source => {
    const { renderDoor } = await import(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
    function pixels(type, orientation, neighbors) {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
      const c = canvas.getContext('2d'); c.imageSmoothingEnabled = false;
      const cell = { x: 1, y: 1, terrain: { type, orientation } };
      renderDoor(c, cell, [cell, ...neighbors.map(([x,y]) => ({ x, y, terrain: { type: 'wall' } }))], 42, 24, 32);
      return canvas.toDataURL();
    }
    return ['closedDoor', 'openDoor'].map(type => {
      const horizontal = pixels(type, 'horizontal', []), vertical = pixels(type, 'vertical', []);
      return {
        distinct: horizontal !== vertical,
        horizontalStable: horizontal === pixels(type, 'horizontal', [[1,0],[1,2]]),
        verticalStable: vertical === pixels(type, 'vertical', [[0,1],[2,1]]),
      };
    });
  }, source);
  assert.deepEqual(result, Array(2).fill({ distinct: true, horizontalStable: true, verticalStable: true }));
});
