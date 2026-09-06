import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '../../../web/neohack.dev/node_modules/playwright-core/index.mjs';
import { createTestHarness } from './server.mjs';
import { mcpTools } from '../../../lib/neonethack/protocol/mcp.ts';

test('workshop low/high imports, complete vocabulary, discovery and session ownership work in the actual sandbox', { timeout: 90000 }, async t => {
  const server = createTestHarness();
  const { url } = await server.listen();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true, chromiumSandbox: true });
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage();
  await page.goto(new URL('/bots', url).href);
  await page.locator('#new-script').click();
  const code = `import {defineBot} from 'neonethack/high';
import {tools} from 'neonethack/low';
export default defineBot({name:'Parity probe',async initialize({game,hero,log}) {
  const expected=${JSON.stringify(mcpTools.map(t => t.name))};
  if(JSON.stringify(tools.map(t=>t.name))!==JSON.stringify(expected)) throw Error('Tool vocabulary differs');
  const discovery=await game.low.call('protocol_describe',{});
  if(!('catalog' in discovery)) throw Error('Discovery unavailable');
  const observed=await game.low.call('session_observe',{sessionId:game.id});
  if(!('observation' in observed)) throw Error('Observation unavailable');
  let denied=false;
  try {await game.low.call('session_create',{});} catch(error) {denied=String(error).includes('workshop owns session creation');}
  if(!denied) throw Error('Workshop creation ownership not enforced');
  await game.observe();
  log('PARITY_OK');hero.stop();
}});`;
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText(code);
  await page.locator('#test').click();
  await page.waitForFunction(() => document.querySelector('#output')?.textContent.includes('PARITY_OK'), null, { timeout: 60000 }).catch(async error => {
    throw Error(await page.locator('#status[role=status]').textContent(), { cause: error });
  });
  assert.match(await page.locator('#output').textContent(), /PARITY_OK/);
});
