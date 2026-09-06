#!/usr/bin/env bun
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';

const root = resolve(import.meta.dir, '..');
const out = resolve(root, 'public/social');
const built = await Bun.build({ entrypoints: [resolve(root, 'src/map.ts')], target: 'browser' });
if (!built.success) throw Error(built.logs.join('\n'));
const javascript = await built.outputs[0]!.text();
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/') return new Response(Bun.file(resolve(root, 'art/social/composition.html')), { headers: { 'Content-Type': 'text/html' } });
  if (path === '/scene.js') return new Response(javascript, { headers: { 'Content-Type': 'text/javascript' } });
  if (/^\/(art|fonts)\/[A-Za-z0-9_.-]+$/.test(path)) return new Response(Bun.file(resolve(root, 'public' + path)));
  return new Response('Not found', { status: 404 });
} });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true, chromiumSandbox: true });
try {
  await mkdir(out, { recursive: true });
  const results = [];
  for (const [format, name, width, height] of [
    ['card', 'open-graph.png', 1200, 630],
    ['banner', 'profile-banner.png', 1500, 500],
    ['overlay', 'stream-overlay.png', 1920, 1080],
  ] as const) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}/?format=${format}`);
    await page.waitForFunction(() => (window as unknown as { artReady: boolean }).artReady);
    if (errors.length) throw Error(errors.join('\n'));
    const png = await page.screenshot({ path: resolve(out, name), omitBackground: format === 'overlay' });
    results.push({ file: name, width, height, sha256: createHash('sha256').update(png).digest('hex') });
    await page.close();
  }
  await writeFile(resolve(out, 'recipe.json'), JSON.stringify({ version: 1, composition: 'art/social/composition.html', renderer: 'src/map.ts:drawWelcomeArt', frameTime: 0, scale: 'integer nearest-neighbor', outputs: results }, null, 2) + '\n');
  console.log(JSON.stringify(results, null, 2));
} finally { await browser.close(); server.stop(true); }
