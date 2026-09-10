import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, symlink, mkdir, copyFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { checkCompiled, checkPackage, compiled, workers, notices } from '../scripts/check-package.mjs';
import { checkInventory, distFiles, nativeFiles, npmSourceFiles, checkNpmSources } from '../scripts/package-files.mjs';
import { readTar } from '../scripts/archive.mjs';
import { safePath, walk, sha256, sourceState, sourceFiles, regularSource, root } from '../scripts/source-files.mjs';
async function sourceFixture(t) {
  const dir = await mkdtemp(`${tmpdir()}/neonethack-package-fixture-`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = `${dir}/source`;
  for (const path of await sourceFiles()) {
    await mkdir(`${base}/${path.slice(0, path.lastIndexOf('/') + 1)}`, { recursive: true });
    await copyFile(`${root}/${path}`, `${base}/${path}`);
  }
  return { dir, base };
}
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
  const { dir, base } = await sourceFixture(t);
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
test('source selection rejects generated and session files even with source-like extensions', async t => {
  const { base } = await sourceFixture(t);
  for (const path of ['tests/sessions/private.json', 'docs/build/report.md', 'src/node_modules/dep/index.ts', 'wasm/dist/worker.mjs']) {
    const parent = path.split('/').slice(0, 2).join('/');
    await mkdir(`${base}/${path.slice(0, path.lastIndexOf('/'))}`, { recursive: true });
    await writeFile(`${base}/${path}`, 'must not be snapshotted');
    await assert.rejects(sourceFiles(base), /Non-source path/);
    await rm(`${base}/${parent}`, { recursive: true });
  }
  const inventory = JSON.parse(await readFile(`${base}/engine/SOURCES.json`, 'utf8'));
  for (const path of ['build/generated.c', 'sessions/private.json', 'src/compiled.o']) {
    await mkdir(`${base}/engine/${path.slice(0, path.lastIndexOf('/'))}`, { recursive: true });
    await writeFile(`${base}/engine/${path}`, 'must not be snapshotted');
    await writeFile(`${base}/engine/SOURCES.json`, JSON.stringify([...inventory, path]));
    await assert.rejects(sourceFiles(base), /Non-source path/);
    await rm(`${base}/engine/${path}`);
  }
});
test('exact dist/native inventories reject omissions, extras and stale public export lists', async () => {
  for (const [files, kind] of [[nativeFiles, 'native'], [distFiles, 'dist']]) {
    checkInventory(files, files, kind);
    for (const missing of files) assert.throws(() => checkInventory(files.filter(path => path !== missing), files, kind), /inventory/);
    assert.throws(() => checkInventory([...files, 'private.json'], files, kind), /inventory/);
  }
  const metadata = JSON.parse(await readFile(`${root}/package.json`, 'utf8'));
  assert.deepEqual(metadata.bin, {'neohack-mcp':'./dist/mcp/cli.js'});
  assert.ok(distFiles.includes('mcp/cli.js'));
  assert.ok(!nativeFiles.some(path=>path.includes('mcp')&&path.startsWith('bin/')));
  const targets = Object.values(metadata.exports).flatMap(value => typeof value === 'string' ? [value] : Object.values(value));
  for (const target of targets) assert.ok((target.startsWith('./dist/') ? distFiles : npmSourceFiles).includes(target.replace(/^\.\/(dist\/)?/, '')), `Public package target missing from inventory: ${target}`);
});
test('package validation and npm file selection include every public module and HTML doc without builds', async t => {
  const { dir, base } = await sourceFixture(t);
  const state = await sourceState(base);
  // Synthetic compiler bytes exercise packaging policy ONLY, not gameplay or
  // the real archive-consumer release gate. Never reuse builder artifacts.
  const directory = `${base}/dist/wasm`;
  await mkdir(directory, { recursive: true });
  const hashes = {};
  for (const name of compiled) {
    const bytes = Buffer.from(`packaging fixture, not executable: ${name}`);
    await writeFile(`${directory}/${name}`, bytes); hashes[name] = sha256(bytes);
  }
  for (const name of workers) await copyFile(`${base}/wasm/${name}`, `${directory}/${name}`);
  for (const name of notices) await writeFile(`${directory}/${name}`, 'Fixture notice, not a license grant. '.repeat(10));
  await copyFile(`${base}/engine/dat/license`, `${directory}/NETHACK-LICENSE.txt`);
  await writeFile(`${directory}/build.json`, JSON.stringify({ version: 1, sourceHash: state.hash, compiled: hashes }));
  const manifestFiles = {};
  async function manifest() {
    for (const name of [...compiled, ...workers].sort()) manifestFiles[name] = sha256(await readFile(`${directory}/${name}`));
    await writeFile(`${directory}/manifest.json`, JSON.stringify({ version: 1, buildId: sha256(JSON.stringify(manifestFiles)), files: manifestFiles }));
  }
  await manifest();
  for (const file of distFiles) {
    await mkdir(`${base}/dist/${file.slice(0, file.lastIndexOf('/'))}`, { recursive: true });
    const bytes = file.endsWith('.json') ? await readFile(`${base}/${file}`)
      : file.endsWith('.js.map') ? JSON.stringify({ sourcesContent: ['// packaging fixture'] }) : 'export {};\n';
    await writeFile(`${base}/dist/${file}`, bytes);
  }
  assert.equal((await checkPackage(base)).sourceHash, state.hash);
  const missing = `${base}/dist/typescript/requests.d.ts`;
  await rename(missing, `${dir}/requests.d.ts`);
  await assert.rejects(checkPackage(base), /dist inventory/);
  await rename(`${dir}/requests.d.ts`, missing);
  await writeFile(`${directory}/core-worker.mjs`, '// changed independently of source'); await manifest();
  await assert.rejects(checkPackage(base), /worker differs from source/);
  await copyFile(`${base}/wasm/core-worker.mjs`, `${directory}/core-worker.mjs`); await manifest();
  await writeFile(`${directory}/NETHACK-LICENSE.txt`, 'Wrong notice. '.repeat(20));
  await assert.rejects(checkPackage(base), /NetHack notice differs from source/);
  await copyFile(`${base}/engine/dat/license`, `${directory}/NETHACK-LICENSE.txt`);
  await mkdir(`${dir}/packed`);
  const [{ filename }] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--offline', '--json', '--cache', `${dir}/cache`, '--pack-destination', `${dir}/packed`], { cwd: base, encoding: 'utf8' }));
  const npm = readTar(await readFile(`${dir}/packed/${filename}`), 'package');
  const sources = new Map(await Promise.all(Object.keys(state.files).map(async path => [`lib/neonethack/${path}`, { data: await readFile(`${base}/${path}`) }])));
  checkNpmSources(sources, npm);
  assert.ok([...npm.keys()].some(path => /^docs\/.*\.html$/.test(path)), 'Real npm selection must include HTML documentation');
  for (const missing of ['NOTICE.md', 'docs/PROTOCOL.md', 'docs/AFFORDANCE-CONTRACT.html']) {
    const incomplete = new Map(npm); incomplete.delete(missing);
    assert.throws(() => checkNpmSources(sources, incomplete), /npm source inventory/);
  }
  const changed = new Map(npm); changed.set('NOTICE.md', { data: Buffer.from('different notice') });
  assert.throws(() => checkNpmSources(sources, changed), /Packed source differs/);
  const leaked = new Map(npm); leaked.set('docs/private.json', { data: Buffer.from('private') });
  assert.throws(() => checkNpmSources(sources, leaked), /npm source inventory/);
});
