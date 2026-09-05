import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, symlink, mkdir, copyFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { checkCompiled, compiled } from '../scripts/check-package.mjs';
import { safePath, walk, sha256, sourceState, sourceFiles, regularSource, root } from '../scripts/source-files.mjs';
test('a TS-only stage cannot re-sign corrupted compiler output', async t => {
  const dir = await mkdtemp(`${tmpdir()}/neonethack-provenance-`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(await checkCompiled(dir, true), null);
  const hashes = {};
  for (const name of compiled) { const bytes = Buffer.from(`test compiler output ${name}`); await writeFile(`${dir}/${name}`, bytes); hashes[name] = sha256(bytes); }
  await assert.rejects(checkCompiled(dir, true), /Missing WASM build provenance/);
  await writeFile(`${dir}/build.json`, JSON.stringify({ version: 1, sourceHash: 'a'.repeat(64), compiled: hashes }));
  await checkCompiled(dir);
  const original = await readFile(`${dir}/build.json`);
  await writeFile(`${dir}/neonethack-core.wasm`, 'damaged');
  await assert.rejects(checkCompiled(dir), /changed since staging/);
  assert.deepEqual(await readFile(`${dir}/build.json`), original);
  assert.equal(await readFile(`${dir}/neonethack-core.wasm`, 'utf8'), 'damaged');
});
test('source selection rejects fixed-root and inventory-parent symlinks without changing their targets', async t => {
  const dir = await mkdtemp(`${tmpdir()}/neonethack-source-parents-`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = `${dir}/source`;
  for (const path of await sourceFiles()) {
    await mkdir(`${base}/${path.slice(0, path.lastIndexOf('/') + 1)}`, { recursive: true });
    await copyFile(`${root}/${path}`, `${base}/${path}`);
  }
  const original = (await sourceState(base)).hash;
  for (const path of ['src', 'engine', 'engine/dat', 'engine/win/headless', 'engine/SOURCES.json', 'engine/dat/license', 'protocol/engine', 'src/api.c']) {
    await rename(`${base}/${path}`, `${dir}/outside`);
    await symlink(`${dir}/outside`, `${base}/${path}`);
    await assert.rejects(sourceFiles(base), /symlink|Symlink|regular file/);
    await rm(`${base}/${path}`); await rename(`${dir}/outside`, `${base}/${path}`);
  }
  await symlink(base, `${dir}/linked-root`);
  await assert.rejects(sourceFiles(`${dir}/linked-root`), /symlink/);
  await assert.rejects(walk(`${dir}/linked-root`), /symlink/);
  // The root example copier uses the same component checks.
  await mkdir(`${dir}/example-target`); await writeFile(`${dir}/example-target/main.c`, 'unchanged');
  await symlink(`${dir}/example-target`, `${base}/examples`);
  await assert.rejects(regularSource(base, 'examples/main.c'), /symlink/);
  assert.equal(await readFile(`${dir}/example-target/main.c`, 'utf8'), 'unchanged');
  assert.equal((await sourceState(base)).hash, original);
});
test('source selection rejects traversal/symlinks and excludes live/generated trees', async t => {
  for (const path of ['../sessions', '/tmp/private', 'a/../b', 'a//b', 'a\\b', 'a\0b']) assert.throws(() => safePath(path));
  const dir = await mkdtemp(`${tmpdir()}/neonethack-source-list-`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await symlink('/does-not-exist', `${dir}/outside`);
  await assert.rejects(walk(dir), /Symlink not allowed/);
  const state = await sourceState();
  assert.ok(Object.keys(state.files).length > 1300);
  assert.ok(Object.keys(state.files).every(p => !/(^|\/)(playground|build|dist|node_modules|sessions|\.git)(\/|$)/.test(p)));
  assert.equal(state.hash, (await sourceState()).hash);
});
