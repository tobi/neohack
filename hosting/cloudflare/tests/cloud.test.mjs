import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { chromium } from '../../../example/pixel-bun/node_modules/playwright-core/index.mjs';

async function fixture(t) {
  const root = resolve(import.meta.dirname, '..');
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const state = await mkdtemp(join(tmpdir(), 'neonethack-cloud-test-'));
  const server = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--local', '--port', String(port), '--persist-to', state, '--show-interactive-dev-session=false'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '', browser;
  server.stdout.on('data', chunk => { logs += chunk; });
  server.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => {
    await browser?.close();
    server.kill('SIGTERM');
    await new Promise(resolve => { server.once('exit', resolve); setTimeout(resolve, 2000).unref(); });
    await rm(state, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { ready = (await fetch(url + '/api/health')).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, logs);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true, chromiumSandbox: true });
  return { url, browser };
}
async function create(page, url) {
  await page.goto(url);
  await page.waitForFunction(() => !document.querySelector('#new-adventure').disabled);
  await page.getByRole('button', { name: 'Begin your adventure', exact: true }).click();
  await page.getByLabel('YOUR NAME', { exact: true }).fill('Bookmark');
  await page.locator('input[name=role][value=valkyrie]').check();
  await page.getByRole('button', { name: 'Enter the dungeon →', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('pixel-nethack').snapshot?.observation && document.querySelector('pixel-nethack').getAttribute('aria-busy') === 'false');
}
const snapshot = page => page.evaluate(() => document.querySelector('pixel-nethack').snapshot);
const synced = page => page.waitForFunction(() => document.querySelector('#cloud-status').textContent === 'Saved online');

test('DO commits are atomic, retry-idempotent and reject stale writers', { timeout: 30000 }, async t => {
  const { url } = await fixture(t);
  const endpoint = `${url}/api/vaults/${crypto.randomUUID()}`;
  const commit = { version: 1, base: null, commit: crypto.randomUUID(), files: [], blocks: [] };
  const put = body => fetch(endpoint, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await put(commit)).status, 200);
  assert.equal((await put(commit)).status, 200);
  assert.equal((await put({ ...commit, base: crypto.randomUUID() })).status, 409);
  const next = { ...commit, base: commit.commit, commit: crypto.randomUUID() };
  assert.equal((await put(next)).status, 200);
  assert.equal((await put({ ...commit, commit: crypto.randomUUID() })).status, 409);
  assert.equal((await (await fetch(endpoint)).json()).revision, next.commit);
  const missing = { ...next, base: next.commit, commit: crypto.randomUUID(), files: [['/neonethack/test/input', { blocks: ['a'.repeat(64)] }]] };
  assert.equal((await put(missing)).status, 400);
  assert.equal((await (await fetch(endpoint)).json()).revision, next.commit);
});

test('turns do not wait for cloud uploads; a bookmark resumes through C in a fresh browser', { timeout: 60000 }, async t => {
  const { url, browser } = await fixture(t);
  const original = await browser.newContext();
  const page = await original.newPage();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let first = true;
  await original.route('**/api/vaults/*', async route => {
    if (route.request().method() !== 'PUT' || !first) return route.continue();
    first = false;
    const response = await route.fetch();
    entered(); await gate;
    await route.fulfill({ response });
  });
  await create(page, url);
  await started;
  const turn = (await snapshot(page)).observation.turn;
  await page.evaluate(async () => { const app = document.querySelector('pixel-nethack'); await app.run(() => app.game.search()); });
  assert.equal((await snapshot(page)).observation.turn, turn + 1, 'turn completed while the server acknowledgement is held: ' + await page.locator('#error').textContent());
  release();
  await page.evaluate(async () => { const app = document.querySelector('pixel-nethack'); await app.run(() => app.game.pray()); });
  await synced(page);
  const before = await snapshot(page), bookmark = page.url();
  assert.match(bookmark, /#run=[A-Za-z0-9_-]+&vault=/);
  assert.equal(before.decision.kind, 'confirmation');
  await page.close();
  const fresh = await browser.newContext();
  const restored = await fresh.newPage();
  await restored.goto(bookmark);
  await restored.waitForFunction(() => document.querySelector('pixel-nethack').snapshot?.observation);
  const after = await snapshot(restored);
  assert.equal(after.sessionId, before.sessionId);
  assert.deepEqual(after.observation, before.observation);
  assert.deepEqual(after.decision, before.decision);
  await restored.evaluate(async () => { const app = document.querySelector('pixel-nethack'); await app.run(() => app.game.answer(app.game.decision.id, { kind: 'confirmation', confirm: false })); });
  assert.equal((await snapshot(restored)).observation.turn, before.observation.turn);
  await synced(restored);
  const latest = await snapshot(restored);
  await fresh.close();
  const returning = await original.newPage();
  await returning.goto(bookmark);
  await returning.waitForFunction(() => document.querySelector('pixel-nethack').snapshot?.observation);
  assert.deepEqual((await snapshot(returning)).observation, latest.observation);
  assert.equal((await snapshot(returning)).decision, null, 'an unchanged older browser cache refreshes from the newer cloud journal');
  await original.close();
});

test('lost cloud acknowledgement recovers the durable commit without replaying an action', { timeout: 60000 }, async t => {
  const { url, browser } = await fixture(t);
  const context = await browser.newContext();
  const page = await context.newPage();
  await create(page, url); await synced(page);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const accepted = new Promise(resolve => { entered = resolve; });
  let first = true;
  await context.route('**/api/vaults/*', async route => {
    if (route.request().method() !== 'PUT' || !first) return route.continue();
    first = false;
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    entered(); await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  await page.evaluate(async () => { const app = document.querySelector('pixel-nethack'); await app.run(() => app.game.search()); });
  const before = await snapshot(page), bookmark = page.url();
  await accepted; await page.close(); release();
  const reopened = await context.newPage(); await reopened.goto(bookmark);
  await reopened.waitForFunction(() => document.querySelector('pixel-nethack').snapshot?.observation);
  const after = await snapshot(reopened);
  assert.equal(after.sessionId, before.sessionId);
  assert.deepEqual(after.observation, before.observation);
  assert.deepEqual(after.decision, before.decision);
  await context.close();
});
